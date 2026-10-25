package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Test suite contract source: docs/agent-foundation.md#local-configuration-contract.

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
		name      string
		wantError string
		mutate    func(*Config)
	}{
		{name: "unsupported version", wantError: "version must be 1", mutate: func(c *Config) { c.Version = 2 }},
		{name: "unknown log level", wantError: "log_level must be", mutate: func(c *Config) { c.LogLevel = "verbose" }},
		{name: "empty cache directory", wantError: "cache.directory is required", mutate: func(c *Config) { c.Cache.Directory = " " }},
		{name: "zero cache limit", wantError: "cache.max_bytes must be greater than zero", mutate: func(c *Config) { c.Cache.MaxBytes = 0 }},
		{name: "empty output directory", wantError: "output.directory is required", mutate: func(c *Config) { c.Output.Directory = "" }},
		{name: "unknown display backend", wantError: `output.backend must be "simulator" or "drm"`, mutate: func(c *Config) { c.Output.Backend = "x11" }},
		{name: "DRM backend requires device", wantError: "output.device is required when output.backend is drm", mutate: func(c *Config) { c.Output.Backend = "drm"; c.Displays[0].Connector = "HDMI-A-1" }},
		{name: "DRM device must be absolute", wantError: "output.device must be an absolute path", mutate: func(c *Config) {
			c.Output.Backend = "drm"
			c.Output.Device = "card1"
			c.Displays[0].Connector = "HDMI-A-1"
		}},
		{name: "invalid fit mode", wantError: `output.fit must be "contain", "cover", or "stretch"`, mutate: func(c *Config) { c.Output.Fit = "crop" }},
		{name: "duplicate playlist", wantError: `playlist id "left" is duplicated`, mutate: func(c *Config) { c.Playlists = append(c.Playlists, c.Playlists[0]) }},
		{name: "unsafe playlist id", wantError: "playlists[0].id contains unsupported characters", mutate: func(c *Config) { c.Playlists[0].ID = "../left" }},
		{name: "playlist without assets", wantError: `playlist "left" must contain at least one asset`, mutate: func(c *Config) { c.Playlists[0].Assets = nil }},
		{name: "empty asset path", wantError: "playlists[0].assets[0].path is required", mutate: func(c *Config) { c.Playlists[0].Assets[0].Path = "" }},
		{name: "invalid asset digest", wantError: "sha256 must be a 64-character hexadecimal SHA-256 digest", mutate: func(c *Config) { c.Playlists[0].Assets[0].SHA256 = "abc" }},
		{name: "duplicate display", wantError: `display id "display-left" is duplicated`, mutate: func(c *Config) { c.Displays = append(c.Displays, c.Displays[0]) }},
		{name: "unsafe display id", wantError: "displays[0].id contains unsupported characters", mutate: func(c *Config) { c.Displays[0].ID = "../left" }},
		{name: "unknown playlist", wantError: `display "display-left" references unknown playlist "missing"`, mutate: func(c *Config) { c.Displays[0].PlaylistID = "missing" }},
		{name: "invalid interval", wantError: "rotation_interval must be greater than zero", mutate: func(c *Config) { c.Displays[0].RotationInterval = "0s" }},
		{name: "DRM display requires connector", wantError: `display "display-left" requires connector when output.backend is drm`, mutate: func(c *Config) { c.Output.Backend = "drm"; c.Output.Device = "/dev/dri/card1" }},
		{name: "duplicate DRM connector", wantError: `connector "HDMI-A-1" is assigned to more than one display`, mutate: func(c *Config) {
			c.Output.Backend = "drm"
			c.Output.Device = "/dev/dri/card1"
			c.Displays[0].Connector = "HDMI-A-1"
			c.Displays = append(c.Displays, DisplayConfig{ID: "display-right", PlaylistID: "left", RotationInterval: "5s", Connector: "HDMI-A-1"})
		}},
		{name: "invalid DRM connector name", wantError: "connector contains unsupported characters", mutate: func(c *Config) {
			c.Output.Backend = "drm"
			c.Output.Device = "/dev/dri/card1"
			c.Displays[0].Connector = "../card1"
		}},
		{name: "invalid display mode", wantError: `mode must be "preferred" or WIDTHxHEIGHT[@REFRESH]`, mutate: func(c *Config) { c.Displays[0].Mode = "1080p" }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := validConfig()
			tt.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("Validate() error = nil, want validation error")
			} else if !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("Validate() error = %v, want diagnostic containing %q", err, tt.wantError)
			}
		})
	}
}

func TestEffectiveBackendDefaultsToSimulator(t *testing.T) {
	if got := validConfig().Output.EffectiveBackend(); got != "simulator" {
		t.Fatalf("EffectiveBackend() = %q, want simulator", got)
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

func TestLoadAppliesHardwareEnvironmentOverridesBeforeValidation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hardware.json")
	body := `{"version":1,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"backend":"drm","fit":"contain"},"playlists":[{"id":"left","assets":[{"path":"assets/one.png"}]}],"displays":[{"id":"display-left","playlist_id":"left","connector":"HDMI-A-1","mode":"preferred","rotation_interval":"5s"}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RIBBONFISH_DRM_DEVICE", "/dev/dri/card1")
	t.Setenv("RIBBONFISH_CACHE_DIR", "/var/lib/ribbonfish/cache")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() with hardware overrides = %v", err)
	}
	if cfg.Output.Device != "/dev/dri/card1" {
		t.Errorf("DRM device = %q, want environment override", cfg.Output.Device)
	}
	if cfg.Cache.Directory != "/var/lib/ribbonfish/cache" {
		t.Errorf("cache directory = %q, want environment override", cfg.Cache.Directory)
	}
}

func TestLoadIgnoresDRMDeviceOverrideForSimulator(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "simulator.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"directory":"frames"},"playlists":[{"id":"left","assets":[{"path":"asset.png"}]}],"displays":[{"id":"display-left","playlist_id":"left","rotation_interval":"5s"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RIBBONFISH_DRM_DEVICE", "/dev/dri/card1")
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Output.Device != "" {
		t.Fatalf("simulator config picked up DRM device %q", cfg.Output.Device)
	}
}
