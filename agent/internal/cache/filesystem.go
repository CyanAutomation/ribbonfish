package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	indexName      = "index.json"
	tempPrefix     = ".ribbonfish-tmp-"
	maxImagePixels = int64(32 * 1024 * 1024)
)

type metadata struct {
	SHA256   string    `json:"sha256"`
	Bytes    int64     `json:"bytes"`
	LastUsed time.Time `json:"last_used"`
}

type indexFile struct {
	Version int        `json:"version"`
	Assets  []metadata `json:"assets"`
}

// FileStore is a single-process, content-addressed cache backed by atomic
// filesystem writes and a recoverable metadata index.
type FileStore struct {
	mu        sync.Mutex
	root      string
	maxBytes  int64
	entries   map[string]metadata
	protected map[string]struct{}
}

var _ Store = (*FileStore)(nil)

// NewFileStore opens or recovers a cache directory. Interrupted temporary
// writes are discarded, and valid orphaned asset files are re-indexed.
func NewFileStore(root string, maxBytes int64) (*FileStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("cache directory is required")
	}
	if maxBytes <= 0 {
		return nil, errors.New("cache max bytes must be greater than zero")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve cache directory: %w", err)
	}
	if err := os.MkdirAll(absRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create cache directory: %w", err)
	}
	store := &FileStore{
		root:      absRoot,
		maxBytes:  maxBytes,
		entries:   make(map[string]metadata),
		protected: make(map[string]struct{}),
	}
	if err := store.recover(); err != nil {
		return nil, err
	}
	return store, nil
}

// Put validates, hashes, and atomically stores an image. If expectedSHA256 is
// non-empty, it must match the image bytes exactly.
func (s *FileStore) Put(ctx context.Context, source io.Reader, expectedSHA256 string) (Asset, error) {
	if source == nil {
		return Asset{}, errors.New("image source is required")
	}
	if err := ctx.Err(); err != nil {
		return Asset{}, err
	}
	temporary, err := os.CreateTemp(s.root, tempPrefix+"asset-")
	if err != nil {
		return Asset{}, fmt.Errorf("create cache temporary file: %w", err)
	}
	tempPath := temporary.Name()
	keepTemp := false
	defer func() {
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()

	hasher := sha256.New()
	limit := s.maxBytes
	if limit < math.MaxInt64 {
		limit++
	}
	bytesWritten, copyErr := io.Copy(io.MultiWriter(temporary, hasher), io.LimitReader(contextReader{ctx: ctx, reader: source}, limit))
	if copyErr != nil {
		_ = temporary.Close()
		return Asset{}, fmt.Errorf("write image to cache: %w", copyErr)
	}
	if bytesWritten > s.maxBytes {
		_ = temporary.Close()
		return Asset{}, fmt.Errorf("cache full: asset is larger than the %d-byte cache limit", s.maxBytes)
	}
	if err := ctx.Err(); err != nil {
		_ = temporary.Close()
		return Asset{}, err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return Asset{}, fmt.Errorf("sync cached image: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return Asset{}, fmt.Errorf("close cached image: %w", err)
	}

	digest := hex.EncodeToString(hasher.Sum(nil))
	if expectedSHA256 != "" && !strings.EqualFold(expectedSHA256, digest) {
		return Asset{}, fmt.Errorf("image integrity check failed: expected %s, got %s", expectedSHA256, digest)
	}
	if err := validateImage(tempPath); err != nil {
		return Asset{}, err
	}
	if err := ctx.Err(); err != nil {
		return Asset{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.protected[digest] = struct{}{}
	finalPath := s.assetPath(digest)
	if existing, ok := s.entries[digest]; ok {
		if verifyErr := verifyFile(finalPath, digest); verifyErr == nil {
			existing.LastUsed = time.Now().UTC()
			s.entries[digest] = existing
			if err := s.saveIndexLocked(); err != nil {
				return Asset{}, err
			}
			return Asset{SHA256: digest, Path: finalPath, Bytes: existing.Bytes}, nil
		}
		delete(s.entries, digest)
	}
	if err := s.makeRoomLocked(bytesWritten); err != nil {
		return Asset{}, err
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		return Asset{}, fmt.Errorf("atomically install cached image: %w", err)
	}
	keepTemp = true
	entry := metadata{SHA256: digest, Bytes: bytesWritten, LastUsed: time.Now().UTC()}
	s.entries[digest] = entry
	if err := syncDirectory(s.root); err != nil {
		return Asset{}, fmt.Errorf("sync cache directory: %w", err)
	}
	if err := s.saveIndexLocked(); err != nil {
		return Asset{}, err
	}
	return Asset{SHA256: digest, Path: finalPath, Bytes: bytesWritten}, nil
}

// Load verifies the on-disk content before decoding it. PNG, JPEG, and GIF are
// supported through Go's standard-library decoders.
func (s *FileStore) Load(ctx context.Context, asset Asset) (image.Image, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validDigest(asset.SHA256) {
		return nil, errors.New("asset integrity check failed: invalid SHA-256 key")
	}
	digest := strings.ToLower(asset.SHA256)
	s.mu.Lock()
	entry, ok := s.entries[digest]
	if !ok {
		s.mu.Unlock()
		return nil, os.ErrNotExist
	}
	if asset.Bytes > 0 && entry.Bytes != asset.Bytes {
		s.mu.Unlock()
		return nil, fmt.Errorf("asset size does not match expected cache metadata: expected %d bytes, got %d", asset.Bytes, entry.Bytes)
	}
	path := s.assetPath(digest)
	if err := verifyFile(path, digest); err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("asset integrity check failed: %w", err)
	}
	file, err := os.Open(path)
	if err != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("open cached image: %w", err)
	}
	decoded, _, decodeErr := image.Decode(file)
	closeErr := file.Close()
	if decodeErr != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("decode cached image: %w", decodeErr)
	}
	if closeErr != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("close cached image: %w", closeErr)
	}
	entry.LastUsed = time.Now().UTC()
	s.entries[digest] = entry
	// LRU metadata is useful but is not required to present a verified image.
	// If this index refresh fails, Close or the next mutation will retry it.
	_ = s.saveIndexLocked()
	s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return decoded, nil
}

// Prune protects the supplied content keys and evicts least-recently-used
// unprotected assets until the stored content fits the configured bound.
func (s *FileStore) Prune(ctx context.Context, retainedSHA256 []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.protected = make(map[string]struct{}, len(retainedSHA256))
	for _, digest := range retainedSHA256 {
		if !validDigest(digest) {
			return fmt.Errorf("retained cache key %q is not a SHA-256 digest", digest)
		}
		s.protected[strings.ToLower(digest)] = struct{}{}
	}
	if err := s.makeRoomLocked(0); err != nil {
		return err
	}
	return s.saveIndexLocked()
}

// Close persists the latest access metadata. The store does not own open files.
func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveIndexLocked()
}

func (s *FileStore) recover() error {
	known := make(map[string]metadata)
	if data, err := os.ReadFile(filepath.Join(s.root, indexName)); err == nil {
		var index indexFile
		if json.Unmarshal(data, &index) == nil && index.Version == 1 {
			for _, entry := range index.Assets {
				if validDigest(entry.SHA256) && entry.Bytes >= 0 {
					known[strings.ToLower(entry.SHA256)] = entry
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read cache metadata: %w", err)
	}

	files, err := os.ReadDir(s.root)
	if err != nil {
		return fmt.Errorf("scan cache directory: %w", err)
	}
	for _, file := range files {
		if strings.HasPrefix(file.Name(), tempPrefix) {
			if err := os.Remove(filepath.Join(s.root, file.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove interrupted cache write %q: %w", file.Name(), err)
			}
			continue
		}
		if !strings.HasSuffix(file.Name(), ".img") {
			continue
		}
		digest := strings.TrimSuffix(file.Name(), ".img")
		if !validDigest(digest) || file.IsDir() {
			continue
		}
		path := filepath.Join(s.root, file.Name())
		if err := verifyFile(path, digest); err != nil {
			if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
				return fmt.Errorf("remove invalid cached image %q: %w", file.Name(), removeErr)
			}
			continue
		}
		info, err := file.Info()
		if err != nil {
			return fmt.Errorf("inspect cached image %q: %w", file.Name(), err)
		}
		entry := metadata{SHA256: digest, Bytes: info.Size(), LastUsed: info.ModTime().UTC()}
		if previous, ok := known[digest]; ok && previous.Bytes == info.Size() && !previous.LastUsed.IsZero() {
			entry.LastUsed = previous.LastUsed
		}
		s.entries[digest] = entry
	}
	return s.saveIndexLocked()
}

func (s *FileStore) makeRoomLocked(incoming int64) error {
	var used int64
	for _, entry := range s.entries {
		used += entry.Bytes
	}
	need := used + incoming - s.maxBytes
	if need <= 0 {
		return nil
	}
	var candidates []metadata
	var available int64
	for digest, entry := range s.entries {
		if _, protected := s.protected[digest]; protected {
			continue
		}
		candidates = append(candidates, entry)
		available += entry.Bytes
	}
	if available < need {
		return fmt.Errorf("cache full: need %d additional bytes but only %d unretained bytes can be evicted", need, available)
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].LastUsed.Before(candidates[j].LastUsed)
	})
	for _, candidate := range candidates {
		if err := os.Remove(s.assetPath(candidate.SHA256)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("evict cached image %s: %w", candidate.SHA256, err)
		}
		delete(s.entries, candidate.SHA256)
		used -= candidate.Bytes
		if used+incoming <= s.maxBytes {
			break
		}
	}
	if err := syncDirectory(s.root); err != nil {
		return fmt.Errorf("sync cache after eviction: %w", err)
	}
	return s.saveIndexLocked()
}

func (s *FileStore) saveIndexLocked() error {
	assets := make([]metadata, 0, len(s.entries))
	for _, entry := range s.entries {
		assets = append(assets, entry)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].SHA256 < assets[j].SHA256 })
	data, err := json.MarshalIndent(indexFile{Version: 1, Assets: assets}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode cache metadata: %w", err)
	}
	temporary, err := os.CreateTemp(s.root, tempPrefix+"index-")
	if err != nil {
		return fmt.Errorf("create cache metadata temporary file: %w", err)
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write cache metadata: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync cache metadata: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close cache metadata: %w", err)
	}
	if err := os.Rename(tempPath, filepath.Join(s.root, indexName)); err != nil {
		return fmt.Errorf("atomically replace cache metadata: %w", err)
	}
	if err := syncDirectory(s.root); err != nil {
		return fmt.Errorf("sync cache metadata directory: %w", err)
	}
	return nil
}

func (s *FileStore) assetPath(digest string) string {
	return filepath.Join(s.root, digest+".img")
}

func validateImage(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open staged image: %w", err)
	}
	config, format, decodeErr := image.DecodeConfig(file)
	closeErr := file.Close()
	if decodeErr != nil {
		return fmt.Errorf("decode image header: %w", decodeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close staged image: %w", closeErr)
	}
	if format != "png" && format != "jpeg" && format != "gif" {
		return fmt.Errorf("unsupported image format %q", format)
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width) > maxImagePixels/int64(config.Height) {
		return fmt.Errorf("image dimensions %dx%d exceed the supported limit", config.Width, config.Height)
	}
	file, err = os.Open(path)
	if err != nil {
		return fmt.Errorf("reopen staged image: %w", err)
	}
	_, _, decodeErr = image.Decode(file)
	closeErr = file.Close()
	if decodeErr != nil {
		return fmt.Errorf("decode image: %w", decodeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close staged image: %w", closeErr)
	}
	return nil
}

func verifyFile(path, digest string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, file)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), digest) {
		return errors.New("SHA-256 does not match cache key")
	}
	return nil
}

func validDigest(digest string) bool {
	if len(digest) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(digest)
	return err == nil && len(decoded) == sha256.Size
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
