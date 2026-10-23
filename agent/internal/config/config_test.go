package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validConfig() Config {
	return Config{
		Version:   1,
		LogLevel:  "info",
		Cache:     CacheConfig{Directory: "cache", MaxBytes: 1024},
		Output:    OutputConfig{Directory: "frames"},
		Playlists: []PlaylistConfig{{ID: "left", Assets: []AssetConfig{{Path: "assets/one.png"}}}},
		Displays:  []DisplayConfig{{ID: "display-left", PlaylistID: "left", RotationInterval: "5s"}},
	}
}

func TestValidateAcceptsValidConfig(t *testing.T) {
	if err := validConfig().Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestValidateRequiresDisplayPlaylistID(t *testing.T) {
	cfg := validConfig()
	cfg.Displays[0].PlaylistID = " "

	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "displays[0].playlist_id is required") {
		t.Fatalf("Validate() error = %v, want required playlist_id diagnostic", err)
	}
}

func TestValidateRejectsInvalidContracts(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{name: "unsupported version", mutate: func(c *Config) { c.Version = 2 }},
		{name: "unknown log level", mutate: func(c *Config) { c.LogLevel = "verbose" }},
		{name: "empty cache directory", mutate: func(c *Config) { c.Cache.Directory = " " }},
		{name: "zero cache limit", mutate: func(c *Config) { c.Cache.MaxBytes = 0 }},
		{name: "empty output directory", mutate: func(c *Config) { c.Output.Directory = "" }},
		{name: "duplicate playlist", mutate: func(c *Config) { c.Playlists = append(c.Playlists, c.Playlists[0]) }},
		{name: "unsafe playlist id", mutate: func(c *Config) { c.Playlists[0].ID = "../left" }},
		{name: "playlist without assets", mutate: func(c *Config) { c.Playlists[0].Assets = nil }},
		{name: "empty asset path", mutate: func(c *Config) { c.Playlists[0].Assets[0].Path = "" }},
		{name: "invalid asset digest", mutate: func(c *Config) { c.Playlists[0].Assets[0].SHA256 = "abc" }},
		{name: "duplicate display", mutate: func(c *Config) { c.Displays = append(c.Displays, c.Displays[0]) }},
		{name: "unsafe display id", mutate: func(c *Config) { c.Displays[0].ID = "../left" }},
		{name: "unknown playlist", mutate: func(c *Config) { c.Displays[0].PlaylistID = "missing" }},
		{name: "invalid interval", mutate: func(c *Config) { c.Displays[0].RotationInterval = "0s" }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := validConfig()
			tt.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("Validate() error = nil, want validation error")
			}
		})
	}
}

func TestLoadRejectsUnknownFieldsAndTrailingJSON(t *testing.T) {
	for _, body := range []string{
		`{"version":1,"unexpected":true}`,
		`{"version":1} {"version":1}`,
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatalf("Load(%q) error = nil, want decoding error", body)
		}
	}
}

func TestLoadResolvesPathsRelativeToConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{
		"version": 1,
		"log_level": "info",
		"cache": {"directory": "cache", "max_bytes": 1024},
		"output": {"directory": "frames"},
		"playlists": [{"id":"left","assets":[{"path":"assets/one.png"}]}],
		"displays": [{"id":"display-left","playlist_id":"left","rotation_interval":"5s"}]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Cache.Directory != filepath.Join(dir, "cache") {
		t.Errorf("cache directory = %q", cfg.Cache.Directory)
	}
	if cfg.Output.Directory != filepath.Join(dir, "frames") {
		t.Errorf("output directory = %q", cfg.Output.Directory)
	}
	if got := cfg.Playlists[0].Assets[0].Path; got != filepath.Join(dir, "assets", "one.png") {
		t.Errorf("asset path = %q", got)
	}
	interval, err := cfg.Displays[0].Interval()
	if err != nil || interval != 5*time.Second {
		t.Errorf("Interval() = %v, %v", interval, err)
	}
}
