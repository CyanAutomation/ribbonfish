package syncer

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
)

const testDeviceToken = "device-secret-012345678901234567890123456789"

func TestHTTPClientDownloadsVerifiedContentAndUsesETag(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{G: 210, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngBytes))
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "revision-2",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: int64(len(pngBytes))}},
	}
	snapshotBytes, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshotRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testDeviceToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v2/playlist":
			if r.Header.Get("X-Ribbonfish-Device-ID") != "pi-office" {
				http.Error(w, "device id missing", http.StatusUnauthorized)
				return
			}
			snapshotRequests++
			if r.Header.Get("If-None-Match") == `"revision-2"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"revision-2"`)
			_, _ = w.Write(snapshotBytes)
		case "/v2/assets/" + digest:
			_, _ = w.Write(pngBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store := syncerStore(t)
	client, err := NewHTTPClient(server.URL, "pi-office", testDeviceToken, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	hardware := syncerConfig()
	update, err := client.Synchronize(context.Background(), hardware, hardware)
	if err != nil {
		t.Fatalf("Synchronize() error = %v", err)
	}
	if !update.Changed || update.Snapshot.Revision != "revision-2" || update.ETag != `"revision-2"` {
		t.Fatalf("unexpected update metadata: %#v", update)
	}
	if update.Config.Output.Directory != hardware.Output.Directory || update.Config.Output.Backend != hardware.Output.Backend {
		t.Fatalf("remote content changed local output settings: %#v", update.Config.Output)
	}
	if got := update.Config.Playlist.RotationInterval; got != "30s" {
		t.Fatalf("rotation interval = %q, want remote interval", got)
	}
	asset := update.Config.Playlist.Assets[0]
	if asset.SHA256 != digest {
		t.Fatalf("asset digest = %q, want %q", asset.SHA256, digest)
	}
	if _, err := store.Load(context.Background(), cache.Asset{SHA256: digest}); err != nil {
		t.Fatalf("downloaded asset not available in cache: %v", err)
	}

	client.SetETag(update.ETag)
	unchanged, err := client.Synchronize(context.Background(), hardware, update.Config)
	if err != nil {
		t.Fatalf("Synchronize() for unchanged snapshot = %v", err)
	}
	if unchanged.Changed || snapshotRequests != 2 {
		t.Fatalf("second result changed=%v, snapshot requests=%d", unchanged.Changed, snapshotRequests)
	}
}

func TestHTTPClientAcceptsWeakPlaylistSnapshotETag(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{R: 140, B: 180, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngBytes))
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "revision-weak",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: int64(len(pngBytes))}},
	}
	snapshotBytes, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testDeviceToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v2/playlist":
			if r.Header.Get("If-None-Match") == `"revision-weak"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `W/"revision-weak"`)
			_, _ = w.Write(snapshotBytes)
		case "/v2/assets/" + digest:
			_, _ = w.Write(pngBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	store := syncerStore(t)
	client, err := NewHTTPClient(server.URL, "pi-office", testDeviceToken, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	hardware := syncerConfig()
	update, err := client.Synchronize(context.Background(), hardware, hardware)
	if err != nil {
		t.Fatalf("Synchronize() with weak ETag error = %v", err)
	}
	if update.ETag != `"revision-weak"` {
		t.Fatalf("canonical ETag = %q, want %q", update.ETag, `"revision-weak"`)
	}
	client.SetETag(update.ETag)
	unchanged, err := client.Synchronize(context.Background(), hardware, update.Config)
	if err != nil {
		t.Fatalf("Synchronize() with canonical conditional ETag = %v", err)
	}
	if unchanged.Changed {
		t.Fatal("Synchronize() changed content after the matching conditional request")
	}
}

func TestHTTPClientRejectsImageDigestMismatchAndRestoresActivePins(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{R: 220, A: 255})
	wrongDigest := strings.Repeat("0", 64)
	snapshotBytes, err := json.Marshal(PlaylistSnapshot{
		Version:          2,
		Revision:         "revision-bad",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: wrongDigest, Size: int64(len(pngBytes))}},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/playlist" {
			w.Header().Set("ETag", `"revision-bad"`)
			_, _ = w.Write(snapshotBytes)
			return
		}
		_, _ = w.Write(pngBytes)
	}))
	defer server.Close()
	store := syncerStore(t)
	oldPNG := syncerPNG(t, color.RGBA{B: 200, A: 255})
	oldAsset, err := store.Put(context.Background(), strings.NewReader(string(oldPNG)), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Prune(context.Background(), []string{oldAsset.SHA256}); err != nil {
		t.Fatal(err)
	}
	active := syncerConfig()
	active.Playlist.Assets[0] = config.AssetConfig{Path: oldAsset.Path, SHA256: oldAsset.SHA256}
	client, err := NewHTTPClient(server.URL, "pi-office", testDeviceToken, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Synchronize(context.Background(), syncerConfig(), active); err == nil || !strings.Contains(err.Error(), "integrity") {
		t.Fatalf("Synchronize() error = %v, want integrity failure", err)
	}
	if _, err := store.Load(context.Background(), cache.Asset{SHA256: oldAsset.SHA256}); err != nil {
		t.Fatalf("active last-good asset was evicted after failed sync: %v", err)
	}
}

func TestHTTPClientRequiresHTTPSOutsideLoopback(t *testing.T) {
	if _, err := NewHTTPClient("http://example.com", "pi-office", "token", syncerStore(t), nil); err == nil {
		t.Fatal("NewHTTPClient accepted a non-HTTPS remote URL")
	}
}

func TestPlaylistSnapshotCannotExceedDeviceCacheBudget(t *testing.T) {
	hardware := syncerConfig()
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "large-revision",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets: []PlaylistAsset{
			{SHA256: strings.Repeat("1", 64), Size: 1 << 20},
			{SHA256: strings.Repeat("2", 64), Size: (1 << 20) + 1},
		},
	}
	if err := validatePlaylistSnapshot(snapshot, hardware); err == nil || !strings.Contains(err.Error(), "cache budget") {
		t.Fatalf("validatePlaylistSnapshot() error = %v, want cache budget rejection", err)
	}
}

func TestPlaylistSnapshotRejectsSingleAssetLargerThanDeviceCache(t *testing.T) {
	hardware := syncerConfig()
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "over-cache-limit",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: strings.Repeat("1", 64), Size: hardware.Cache.MaxBytes + 1}},
	}
	if err := validatePlaylistSnapshot(snapshot, hardware); err == nil || !strings.Contains(err.Error(), "cache budget") {
		t.Fatalf("validatePlaylistSnapshot() error = %v, want cache budget rejection", err)
	}
}

func TestDecodePlaylistSnapshotRejectsInputOverSizeLimit(t *testing.T) {
	_, err := decodePlaylistSnapshot(strings.NewReader(strings.Repeat(" ", snapshotLimit+1)))
	if err == nil || !strings.Contains(err.Error(), "1 MiB limit") {
		t.Fatalf("decodePlaylistSnapshot() error = %v, want snapshot size-limit rejection", err)
	}
}

func TestHTTPClientRejectsChunkedOversizedAssetWithoutCaching(t *testing.T) {
	pngData := syncerPNG(t, color.RGBA{R: 150, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngData))
	snapshotBytes, err := json.Marshal(PlaylistSnapshot{
		Version:          2,
		Revision:         "wrong-size",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: int64(len(pngData) - 1)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/playlist" {
			_, _ = w.Write(snapshotBytes)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		_, _ = w.Write(pngData)
	}))
	defer server.Close()

	store := syncerStore(t)
	client, err := NewHTTPClient(server.URL, "pi-office", testDeviceToken, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Synchronize(context.Background(), syncerConfig(), syncerConfig()); err == nil || !strings.Contains(err.Error(), "size") {
		t.Fatalf("Synchronize() error = %v, want declared-size rejection", err)
	}
	if _, err := store.Load(context.Background(), cache.Asset{SHA256: digest}); err == nil {
		t.Fatal("oversized response was committed to the cache")
	}
}

func TestHTTPClientRejectsCachedAssetWithWrongPlaylistSnapshotSize(t *testing.T) {
	pngData := syncerPNG(t, color.RGBA{G: 150, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngData))
	snapshotBytes, err := json.Marshal(PlaylistSnapshot{
		Version:          2,
		Revision:         "cached-wrong-size",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: int64(len(pngData) - 1)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/playlist" {
			_, _ = w.Write(snapshotBytes)
			return
		}
		_, _ = w.Write(pngData)
	}))
	defer server.Close()

	store := syncerStore(t)
	if _, err := store.Put(context.Background(), strings.NewReader(string(pngData)), digest); err != nil {
		t.Fatal(err)
	}
	client, err := NewHTTPClient(server.URL, "pi-office", testDeviceToken, store, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Synchronize(context.Background(), syncerConfig(), syncerConfig()); err == nil || !strings.Contains(err.Error(), "length mismatch") {
		t.Fatalf("Synchronize() error = %v, want snapshot size mismatch", err)
	}
}

func TestEnrollWritesDeviceTokenWithPrivatePermissions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/enroll" {
			http.NotFound(w, r)
			return
		}
		var request struct {
			DeviceID string `json:"device_id"`
			Code     string `json:"enrollment_code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode enrollment request: %v", err)
		}
		if request.DeviceID != "pi-office" || request.Code != "one-time-code" {
			t.Errorf("enrollment request = %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device_token":"device-token-response-0123456789abcdef"}`))
	}))
	defer server.Close()
	token, err := Enroll(context.Background(), server.URL, "pi-office", "one-time-code", server.Client())
	if err != nil {
		t.Fatalf("Enroll() error = %v", err)
	}
	filename := filepath.Join(t.TempDir(), "state", "device-token")
	if err := WriteDeviceToken(filename, token); err != nil {
		t.Fatalf("WriteDeviceToken() error = %v", err)
	}
	got, err := ReadDeviceToken(filename)
	if err != nil || got != token {
		t.Fatalf("ReadDeviceToken() = %q, %v", got, err)
	}
	info, err := os.Stat(filename)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("device token permissions = %04o, want 0600", info.Mode().Perm())
	}
}

func TestSaveAndLoadSnapshotRequiresEveryPinnedImage(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{B: 180, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngBytes))
	store := syncerStore(t)
	asset, err := store.Put(context.Background(), strings.NewReader(string(pngBytes)), digest)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "saved-revision",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: asset.Bytes}},
	}
	hardware := syncerConfig()
	candidate, err := mergePlaylistSnapshot(hardware, snapshot, map[string]cache.Asset{digest: asset})
	if err != nil {
		t.Fatal(err)
	}
	update := Update{Config: candidate, Snapshot: snapshot, ETag: `"saved-revision"`, Changed: true}
	filename := filepath.Join(t.TempDir(), "last-good.json")
	if err := SaveSnapshot(filename, update); err != nil {
		t.Fatalf("SaveSnapshot() error = %v", err)
	}
	restored, err := LoadSnapshot(filename, hardware, store)
	if err != nil || restored.Snapshot.Revision != snapshot.Revision || restored.Config.Playlist.Assets[0].SHA256 != digest {
		t.Fatalf("LoadSnapshot() = %#v, %v", restored, err)
	}
	if err := os.WriteFile(asset.Path, []byte("corrupt"), 0o600); err != nil {
		t.Fatalf("corrupt test cache image: %v", err)
	}
	if _, err := LoadSnapshot(filename, hardware, store); err == nil {
		t.Fatal("LoadSnapshot accepted a snapshot with a missing image")
	}
}

func TestLoadSnapshotPinsImagesBeforeValidatingAndMerging(t *testing.T) {
	pngData := syncerPNG(t, color.RGBA{R: 120, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngData))
	fileStore := syncerStore(t)
	asset, err := fileStore.Put(context.Background(), strings.NewReader(string(pngData)), digest)
	if err != nil {
		t.Fatal(err)
	}
	hardware := syncerConfig()
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         "restore-pin-order",
		ID:               "welcome",
		RotationInterval: "30s",
		Assets:           []PlaylistAsset{{SHA256: digest, Size: asset.Bytes}},
	}
	candidate, err := mergePlaylistSnapshot(hardware, snapshot, map[string]cache.Asset{digest: asset})
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "last-good.json")
	if err := SaveSnapshot(filename, Update{Config: candidate, Snapshot: snapshot, ETag: `"restore-pin-order"`, Changed: true}); err != nil {
		t.Fatal(err)
	}

	store := &observingStore{FileStore: fileStore}
	if _, err := LoadSnapshot(filename, hardware, store); err != nil {
		t.Fatalf("LoadSnapshot() error = %v", err)
	}
	if len(store.events) < 2 || store.events[0] != "prune" || store.events[1] != "load" {
		t.Fatalf("store operation order = %v, want prune before load", store.events)
	}
	if len(store.retained) == 0 || !containsDigest(store.retained[0], digest) {
		t.Fatalf("initial retained cache keys = %v, want snapshot digest %s", store.retained, digest)
	}
}

type observingStore struct {
	*cache.FileStore
	events   []string
	retained [][]string
}

func (s *observingStore) Load(ctx context.Context, asset cache.Asset) (image.Image, error) {
	s.events = append(s.events, "load")
	return s.FileStore.Load(ctx, asset)
}

func (s *observingStore) Prune(ctx context.Context, digests []string) error {
	s.events = append(s.events, "prune")
	s.retained = append(s.retained, append([]string(nil), digests...))
	return s.FileStore.Prune(ctx, digests)
}

func containsDigest(digests []string, expected string) bool {
	for _, digest := range digests {
		if digest == expected {
			return true
		}
	}
	return false
}

func syncerStore(t *testing.T) *cache.FileStore {
	t.Helper()
	store, err := cache.NewFileStore(filepath.Join(t.TempDir(), "cache"), 2<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func syncerConfig() config.Config {
	return config.Config{
		Version:  2,
		LogLevel: "info",
		Cache:    config.CacheConfig{Directory: "/var/cache/ribbonfish", MaxBytes: 2 << 20},
		Output:   config.OutputConfig{Backend: "simulator", Directory: "/var/frames", Fit: "contain"},
		Playlist: config.PlaylistConfig{ID: "default", RotationInterval: "10s", Assets: []config.AssetConfig{{Path: "/starter.png"}}},
		Displays: []config.DisplayConfig{{ID: "screen-main", Mode: "preferred"}},
	}
}

func syncerPNG(t *testing.T, fill color.RGBA) []byte {
	t.Helper()
	var data strings.Builder
	frame := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			frame.SetRGBA(x, y, fill)
		}
	}
	if err := png.Encode(&data, frame); err != nil {
		t.Fatal(err)
	}
	return []byte(data.String())
}
