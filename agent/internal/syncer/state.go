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
	Version  int              `json:"version"`
	ETag     string           `json:"etag"`
	Snapshot PlaylistSnapshot `json:"playlist"`
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
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var saved savedSnapshot
	if err := decoder.Decode(&saved); err != nil {
		return Update{}, fmt.Errorf("decode last-good snapshot: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return Update{}, errors.New("last-good snapshot contains multiple JSON values")
		}
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
