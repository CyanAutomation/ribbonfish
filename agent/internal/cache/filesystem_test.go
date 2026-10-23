package cache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngBytes(t *testing.T, value color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			img.SetRGBA(x, y, value)
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func TestFileStorePersistsVerifiedImagesAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	data := pngBytes(t, color.RGBA{R: 220, A: 255})
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	asset, err := store.Put(context.Background(), bytes.NewReader(data), "")
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	wantHash := sha256.Sum256(data)
	if asset.SHA256 != hex.EncodeToString(wantHash[:]) {
		t.Fatalf("asset digest = %q", asset.SHA256)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatalf("NewFileStore() after restart: %v", err)
	}
	loaded, err := restarted.Load(context.Background(), asset)
	if err != nil {
		t.Fatalf("Load() after restart: %v", err)
	}
	if got := loaded.Bounds().Size(); got != image.Pt(4, 3) {
		t.Errorf("decoded size = %v", got)
	}
	asset.SHA256 = strings.ToUpper(asset.SHA256)
	if _, err := restarted.Load(context.Background(), asset); err != nil {
		t.Errorf("Load() with uppercase digest: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err != nil {
		t.Errorf("cache metadata missing: %v", err)
	}
}

func TestFileStoreRejectsBadDigestAndCorruptedContent(t *testing.T) {
	dir := t.TempDir()
	data := pngBytes(t, color.RGBA{G: 180, A: 255})
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), bytes.NewReader(data), strings.Repeat("0", 64)); err == nil {
		t.Fatal("Put() accepted a mismatched expected digest")
	}
	asset, err := store.Put(context.Background(), bytes.NewReader(data), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(asset.Path, []byte("corrupted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(context.Background(), asset); err == nil || !strings.Contains(err.Error(), "integrity") {
		t.Fatalf("Load() error = %v, want integrity error", err)
	}
}

func TestFileStoreRejectsCorruptImageBeforePublishing(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), strings.NewReader("not an image"), ""); err == nil {
		t.Fatal("Put() accepted corrupt image bytes")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".img") {
			t.Errorf("corrupt image was published: %s", entry.Name())
		}
	}
}

func TestFileStoreEvictsLeastRecentlyUsedUnretainedAsset(t *testing.T) {
	red := pngBytes(t, color.RGBA{R: 255, A: 255})
	green := pngBytes(t, color.RGBA{G: 255, A: 255})
	blue := pngBytes(t, color.RGBA{B: 255, A: 255})
	if len(red) != len(green) || len(red) != len(blue) {
		t.Fatal("fixture PNG lengths differ; adjust cache limit test")
	}
	store, err := NewFileStore(t.TempDir(), int64(len(red)*2))
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Put(context.Background(), bytes.NewReader(red), "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Put(context.Background(), bytes.NewReader(green), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Prune(context.Background(), []string{first.SHA256}); err != nil {
		t.Fatal(err)
	}
	third, err := store.Put(context.Background(), bytes.NewReader(blue), "")
	if err != nil {
		t.Fatalf("Put() with one unretained eviction candidate: %v", err)
	}
	if _, err := store.Load(context.Background(), first); err != nil {
		t.Errorf("retained first asset was evicted: %v", err)
	}
	if _, err := os.Stat(second.Path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("unretained asset still exists, stat error = %v", err)
	}
	if _, err := store.Load(context.Background(), third); err != nil {
		t.Errorf("new asset unavailable: %v", err)
	}
}

func TestFileStoreFailsWhenRequiredAssetsFillCache(t *testing.T) {
	red := pngBytes(t, color.RGBA{R: 255, A: 255})
	green := pngBytes(t, color.RGBA{G: 255, A: 255})
	store, err := NewFileStore(t.TempDir(), int64(len(red)))
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Put(context.Background(), bytes.NewReader(red), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Prune(context.Background(), []string{first.SHA256}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), bytes.NewReader(green), ""); err == nil || !strings.Contains(err.Error(), "cache full") {
		t.Fatalf("Put() error = %v, want cache full", err)
	}
	if _, err := store.Load(context.Background(), first); err != nil {
		t.Fatalf("required asset was lost after failed Put(): %v", err)
	}
}

func TestFileStoreCleansInterruptedWritesAndRecoversOrphanAsset(t *testing.T) {
	dir := t.TempDir()
	data := pngBytes(t, color.RGBA{B: 255, A: 255})
	hash := sha256.Sum256(data)
	key := hex.EncodeToString(hash[:])
	if err := os.WriteFile(filepath.Join(dir, key+".img"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".ribbonfish-tmp-interrupted"), data[:len(data)/2], 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.json"), []byte(`{"version":`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	asset := Asset{SHA256: key, Path: filepath.Join(dir, key+".img"), Bytes: int64(len(data))}
	if _, err := store.Load(context.Background(), asset); err != nil {
		t.Fatalf("recovered orphan asset: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".ribbonfish-tmp-interrupted")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("interrupted temp file remains, stat error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err != nil {
		t.Errorf("rebuilt metadata missing: %v", err)
	}
}

type interruptedReader struct{ sent bool }

func (r *interruptedReader) Read(p []byte) (int, error) {
	if r.sent {
		return 0, errors.New("simulated interrupted write")
	}
	r.sent = true
	copy(p, "partial image data")
	return len("partial image data"), nil
}

func TestFileStoreRemovesPartialTemporaryFileAfterReadFailure(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(context.Background(), &interruptedReader{}, ""); err == nil {
		t.Fatal("Put() error = nil, want simulated write failure")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".img") || strings.HasPrefix(entry.Name(), ".ribbonfish-tmp-") {
			t.Errorf("partial cache file remains: %s", entry.Name())
		}
	}
	_, err = store.Put(context.Background(), bytes.NewReader(pngBytes(t, color.RGBA{A: 255})), "")
	if err != nil {
		t.Fatalf("Put() recovery after interrupted write: %v", err)
	}
}

func TestFileStoreHonorsCancelledContextWithoutPublishing(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Put(ctx, bytes.NewReader(pngBytes(t, color.RGBA{A: 255})), ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put() error = %v, want context.Canceled", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".img") || strings.HasPrefix(entry.Name(), ".ribbonfish-tmp-") {
			t.Errorf("cancelled write left partial file %s", entry.Name())
		}
	}
}
