package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
)

type savedSnapshot struct {
	Version  int      `json:"version"`
	ETag     string   `json:"etag"`
	Manifest Manifest `json:"manifest"`
}

// SaveSnapshot atomically persists only a verified manifest and its revision.
// Image bytes remain in the content-addressed cache.
func SaveSnapshot(filename string, update Update) error {
	if !update.Changed {
		return errors.New("cannot persist an unchanged synchronization result")
	}
	if err := validateManifest(update.Manifest, update.Config); err != nil {
		return fmt.Errorf("refuse invalid snapshot: %w", err)
	}
	if update.ETag != `"`+update.Manifest.Revision+`"` {
		return errors.New("snapshot ETag must match its manifest revision")
	}
	data, err := json.Marshal(savedSnapshot{Version: 1, ETag: update.ETag, Manifest: update.Manifest})
	if err != nil {
		return fmt.Errorf("encode last-good manifest: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return fmt.Errorf("create snapshot directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(filename), ".ribbonfish-manifest-*")
	if err != nil {
		return fmt.Errorf("create snapshot temporary file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure snapshot temporary file: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write last-good manifest: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync last-good manifest: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close last-good manifest: %w", err)
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return fmt.Errorf("activate last-good manifest: %w", err)
	}
	directory, err := os.Open(filepath.Dir(filename))
	if err != nil {
		return fmt.Errorf("open snapshot directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync snapshot directory: %w", err)
	}
	return nil
}

// LoadSnapshot restores a persisted remote snapshot only when its manifest and
// every pinned image still validate. Callers can then fall back to bundled
// content if this function returns an error.
func LoadSnapshot(filename string, hardware config.Config, store cache.Store) (Update, error) {
	file, err := os.Open(filename)
	if err != nil {
		return Update{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, manifestLimit+1))
	if err != nil {
		return Update{}, fmt.Errorf("read last-good manifest: %w", err)
	}
	if len(data) > manifestLimit {
		return Update{}, errors.New("last-good manifest exceeds 1 MiB limit")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var saved savedSnapshot
	if err := decoder.Decode(&saved); err != nil {
		return Update{}, fmt.Errorf("decode last-good manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return Update{}, errors.New("last-good manifest contains multiple JSON values")
		}
		return Update{}, fmt.Errorf("decode last-good manifest: %w", err)
	}
	if saved.Version != 1 || saved.ETag != `"`+saved.Manifest.Revision+`"` {
		return Update{}, errors.New("last-good manifest has an unsupported state version or ETag")
	}
	if err := validateManifest(saved.Manifest, hardware); err != nil {
		return Update{}, fmt.Errorf("validate last-good manifest: %w", err)
	}
	assets := make(map[string]cache.Asset)
	for _, digest := range manifestDigests(saved.Manifest) {
		if _, err := store.Load(context.Background(), cache.Asset{SHA256: digest}); err != nil {
			return Update{}, fmt.Errorf("last-good image %s is unavailable: %w", digest, err)
		}
		for _, playlist := range saved.Manifest.Playlists {
			for _, item := range playlist.Assets {
				if strings.EqualFold(item.SHA256, digest) {
					assets[digest] = cache.Asset{SHA256: digest, Path: "cached:" + digest, Bytes: item.Size}
					break
				}
			}
		}
	}
	candidate, err := mergeManifest(hardware, saved.Manifest, assets)
	if err != nil {
		return Update{}, err
	}
	if err := store.Prune(context.Background(), manifestDigests(saved.Manifest)); err != nil {
		return Update{}, fmt.Errorf("protect restored images: %w", err)
	}
	return Update{Config: candidate, Manifest: saved.Manifest, ETag: saved.ETag, Changed: true}, nil
}
