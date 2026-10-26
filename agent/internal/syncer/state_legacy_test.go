package syncer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
)

func TestLoadSnapshotMigratesLegacyManifest(t *testing.T) {
	pngBytes := syncerPNG(t, color.RGBA{R: 40, G: 120, B: 200, A: 255})
	digest := fmt.Sprintf("%x", sha256.Sum256(pngBytes))
	store := syncerStore(t)
	asset, err := store.Put(context.Background(), bytes.NewReader(pngBytes), digest)
	if err != nil {
		t.Fatal(err)
	}

	hardware := syncerConfig()
	hardware.Displays[0].ID = "display-main"
	const oldRevision = "ribbonfish-01-1"
	legacy := map[string]any{
		"version": 1,
		"etag":    `"` + oldRevision + `"`,
		"manifest": map[string]any{
			"version":  1,
			"revision": oldRevision,
			"playlists": []any{
				map[string]any{
					"id":     "operations",
					"assets": []any{map[string]any{"sha256": digest, "size": asset.Bytes}},
				},
			},
			"displays": []any{
				map[string]any{"id": "display-main", "playlist_id": "operations", "rotation_interval": "30s"},
			},
		},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "last-good.json")
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatal(err)
	}

	restored, err := LoadSnapshot(filename, hardware, store)
	if err != nil {
		t.Fatalf("LoadSnapshot() error = %v", err)
	}
	if restored.Snapshot.Version != 2 || restored.Snapshot.ID != "operations" || restored.Snapshot.RotationInterval != "30s" {
		t.Fatalf("migrated snapshot = %#v", restored.Snapshot)
	}
	if !strings.HasPrefix(restored.Snapshot.Revision, "legacy-") || restored.ETag != `"`+restored.Snapshot.Revision+`"` {
		t.Fatalf("migrated revision/ETag = %q / %q", restored.Snapshot.Revision, restored.ETag)
	}
	if len(restored.Config.Playlist.Assets) != 1 || restored.Config.Playlist.Assets[0].Path != "cached:"+digest {
		t.Fatalf("restored playlist assets = %#v", restored.Config.Playlist.Assets)
	}
	if _, err := store.Load(context.Background(), cache.Asset{SHA256: digest, Bytes: asset.Bytes}); err != nil {
		t.Fatalf("legacy cached image was not retained: %v", err)
	}
}

func TestLoadSnapshotRejectsLegacyManifestWithDifferentDisplayContent(t *testing.T) {
	hardware := syncerConfig()
	hardware.Displays = []config.DisplayConfig{{ID: "display-a"}, {ID: "display-b"}}
	const oldRevision = "multi-display-revision"
	legacy := map[string]any{
		"version": 1,
		"etag":    `"` + oldRevision + `"`,
		"manifest": map[string]any{
			"version":  1,
			"revision": oldRevision,
			"playlists": []any{
				map[string]any{"id": "first", "assets": []any{}},
				map[string]any{"id": "second", "assets": []any{}},
			},
			"displays": []any{
				map[string]any{"id": "display-a", "playlist_id": "first", "rotation_interval": "15s"},
				map[string]any{"id": "display-b", "playlist_id": "second", "rotation_interval": "15s"},
			},
		},
	}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "last-good.json")
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadSnapshot(filename, hardware, syncerStore(t)); err == nil ||
		!strings.Contains(err.Error(), "assigns different content to local displays") {
		t.Fatalf("LoadSnapshot() error = %v, want incompatible legacy display assignments", err)
	}
}
