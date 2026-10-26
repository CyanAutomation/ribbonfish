package syncer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
)

type savedSnapshot struct {
	Version  int              `json:"version"`
	ETag     string           `json:"etag"`
	Snapshot PlaylistSnapshot `json:"playlist"`
}

type legacySavedSnapshot struct {
	Version  int            `json:"version"`
	ETag     string         `json:"etag"`
	Manifest legacyManifest `json:"manifest"`
}

type legacyManifest struct {
	Version   int              `json:"version"`
	Revision  string           `json:"revision"`
	Playlists []legacyPlaylist `json:"playlists"`
	Displays  []legacyDisplay  `json:"displays"`
}

type legacyPlaylist struct {
	ID     string          `json:"id"`
	Assets []PlaylistAsset `json:"assets"`
}

type legacyDisplay struct {
	ID               string `json:"id"`
	PlaylistID       string `json:"playlist_id"`
	RotationInterval string `json:"rotation_interval"`
}

// SaveSnapshot atomically persists only a verified snapshot and its revision.
// Image bytes remain in the content-addressed cache.
func SaveSnapshot(filename string, update Update) error {
	if !update.Changed {
		return errors.New("cannot persist an unchanged synchronization result")
	}
	if err := validatePlaylistSnapshot(update.Snapshot, update.Config); err != nil {
		return fmt.Errorf("refuse invalid snapshot: %w", err)
	}
	if update.ETag != `"`+update.Snapshot.Revision+`"` {
		return errors.New("snapshot ETag must match its snapshot revision")
	}
	data, err := json.Marshal(savedSnapshot{Version: 2, ETag: update.ETag, Snapshot: update.Snapshot})
	if err != nil {
		return fmt.Errorf("encode last-good snapshot: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return fmt.Errorf("create snapshot directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(filename), ".ribbonfish-snapshot-*")
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
		return fmt.Errorf("write last-good snapshot: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync last-good snapshot: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close last-good snapshot: %w", err)
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return fmt.Errorf("activate last-good snapshot: %w", err)
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

// LoadSnapshot restores a persisted remote playlist only when the snapshot and
// every pinned image still validate. Callers can then fall back to bundled
// content if this function returns an error.
func LoadSnapshot(filename string, hardware config.Config, store cache.Store) (Update, error) {
	file, err := os.Open(filename)
	if err != nil {
		return Update{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, snapshotLimit+1))
	if err != nil {
		return Update{}, fmt.Errorf("read last-good snapshot: %w", err)
	}
	if len(data) > snapshotLimit {
		return Update{}, errors.New("last-good snapshot exceeds 1 MiB limit")
	}
	saved, err := decodeLastGoodSnapshot(data, hardware)
	if err != nil {
		return Update{}, fmt.Errorf("decode last-good snapshot: %w", err)
	}
	if saved.Version != 2 || saved.ETag != `"`+saved.Snapshot.Revision+`"` {
		return Update{}, errors.New("last-good snapshot has an unsupported state version or ETag")
	}
	if err := validatePlaylistSnapshot(saved.Snapshot, hardware); err != nil {
		return Update{}, fmt.Errorf("validate last-good snapshot: %w", err)
	}
	assets := make(map[string]cache.Asset)
	for _, item := range saved.Snapshot.Assets {
		digest := strings.ToLower(item.SHA256)
		assets[digest] = cache.Asset{SHA256: digest, Path: "cached:" + digest, Bytes: item.Size}
	}
	retained := append(configDigests(hardware), snapshotDigests(saved.Snapshot)...)
	if err := store.Prune(context.Background(), retained); err != nil {
		return Update{}, fmt.Errorf("protect restored images: %w", err)
	}
	for _, digest := range snapshotDigests(saved.Snapshot) {
		asset := assets[digest]
		if _, err := store.Load(context.Background(), cache.Asset{SHA256: digest, Bytes: asset.Bytes}); err != nil {
			return Update{}, fmt.Errorf("last-good image %s is unavailable: %w", digest, err)
		}
	}
	candidate, err := mergePlaylistSnapshot(hardware, saved.Snapshot, assets)
	if err != nil {
		return Update{}, err
	}
	return Update{Config: candidate, Snapshot: saved.Snapshot, ETag: saved.ETag, Changed: true}, nil
}

func decodeLastGoodSnapshot(data []byte, hardware config.Config) (savedSnapshot, error) {
	var saved savedSnapshot
	currentErr := decodeStrictJSON(data, &saved)
	if currentErr == nil {
		return saved, nil
	}

	var legacy legacySavedSnapshot
	if err := decodeStrictJSON(data, &legacy); err != nil {
		return savedSnapshot{}, currentErr
	}
	snapshot, err := migrateLegacyManifest(data, legacy, hardware)
	if err != nil {
		return savedSnapshot{}, err
	}
	return savedSnapshot{
		Version:  2,
		ETag:     `"` + snapshot.Revision + `"`,
		Snapshot: snapshot,
	}, nil
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("last-good snapshot contains multiple JSON values")
		}
		return err
	}
	return nil
}

func migrateLegacyManifest(data []byte, saved legacySavedSnapshot, hardware config.Config) (PlaylistSnapshot, error) {
	manifest := saved.Manifest
	if saved.Version != 1 || manifest.Version != 1 || !validID(manifest.Revision) ||
		saved.ETag != `"`+manifest.Revision+`"` {
		return PlaylistSnapshot{}, errors.New("legacy last-good manifest has an unsupported version or ETag")
	}
	if len(manifest.Playlists) == 0 || len(manifest.Playlists) > 64 || len(manifest.Displays) != len(hardware.Displays) {
		return PlaylistSnapshot{}, errors.New("legacy last-good manifest does not match the local display profile")
	}

	playlists := make(map[string]legacyPlaylist, len(manifest.Playlists))
	for _, playlist := range manifest.Playlists {
		if !validID(playlist.ID) {
			return PlaylistSnapshot{}, fmt.Errorf("legacy last-good manifest has invalid playlist id %q", playlist.ID)
		}
		if _, exists := playlists[playlist.ID]; exists {
			return PlaylistSnapshot{}, fmt.Errorf("legacy last-good manifest has duplicate playlist id %q", playlist.ID)
		}
		playlists[playlist.ID] = playlist
	}

	displays := make(map[string]legacyDisplay, len(manifest.Displays))
	for _, display := range manifest.Displays {
		if !validID(display.ID) {
			return PlaylistSnapshot{}, fmt.Errorf("legacy last-good manifest has invalid display id %q", display.ID)
		}
		if _, exists := displays[display.ID]; exists {
			return PlaylistSnapshot{}, fmt.Errorf("legacy last-good manifest has duplicate display id %q", display.ID)
		}
		if _, exists := playlists[display.PlaylistID]; !exists {
			return PlaylistSnapshot{}, fmt.Errorf("legacy display %q references unknown playlist %q", display.ID, display.PlaylistID)
		}
		if _, err := time.ParseDuration(display.RotationInterval); err != nil {
			return PlaylistSnapshot{}, fmt.Errorf("legacy display %q has invalid rotation interval: %w", display.ID, err)
		}
		if interval, _ := time.ParseDuration(display.RotationInterval); interval <= 0 {
			return PlaylistSnapshot{}, fmt.Errorf("legacy display %q rotation interval must be positive", display.ID)
		}
		displays[display.ID] = display
	}

	var playlistID, rotationInterval string
	var selectedInterval time.Duration
	for _, display := range hardware.Displays {
		legacy, ok := displays[display.ID]
		if !ok {
			return PlaylistSnapshot{}, fmt.Errorf("legacy last-good manifest is missing local display %q", display.ID)
		}
		interval, _ := time.ParseDuration(legacy.RotationInterval)
		if playlistID == "" {
			playlistID, rotationInterval, selectedInterval = legacy.PlaylistID, legacy.RotationInterval, interval
			continue
		}
		if legacy.PlaylistID != playlistID || interval != selectedInterval {
			return PlaylistSnapshot{}, errors.New("legacy last-good manifest assigns different content to local displays")
		}
	}

	selected := playlists[playlistID]
	sum := sha256.Sum256(data)
	revision := "legacy-" + hex.EncodeToString(sum[:28])
	snapshot := PlaylistSnapshot{
		Version:          2,
		Revision:         revision,
		ID:               selected.ID,
		RotationInterval: rotationInterval,
		Assets:           append([]PlaylistAsset(nil), selected.Assets...),
	}
	if err := validatePlaylistSnapshot(snapshot, hardware); err != nil {
		return PlaylistSnapshot{}, fmt.Errorf("validate migrated last-good playlist: %w", err)
	}
	return snapshot, nil
}
