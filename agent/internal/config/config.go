// Package config defines and validates the agent's local configuration
// contract. It intentionally contains no control-plane or hardware settings.
package config

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config describes the local, offline-capable agent. Paths are resolved
// relative to the config file by Load.
type Config struct {
	Version   int              `json:"version"`
	LogLevel  string           `json:"log_level"`
	Cache     CacheConfig      `json:"cache"`
	Output    OutputConfig     `json:"output"`
	Playlists []PlaylistConfig `json:"playlists"`
	Displays  []DisplayConfig  `json:"displays"`
}

type CacheConfig struct {
	Directory string `json:"directory"`
	MaxBytes  int64  `json:"max_bytes"`
}

type OutputConfig struct {
	Directory string `json:"directory"`
}

type PlaylistConfig struct {
	ID     string        `json:"id"`
	Assets []AssetConfig `json:"assets"`
}

type AssetConfig struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
}

type DisplayConfig struct {
	ID               string `json:"id"`
	PlaylistID       string `json:"playlist_id"`
	RotationInterval string `json:"rotation_interval"`
}

// Interval parses a display's rotation interval.
func (d DisplayConfig) Interval() (time.Duration, error) {
	interval, err := time.ParseDuration(d.RotationInterval)
	if err != nil {
		return 0, fmt.Errorf("display %q rotation_interval: %w", d.ID, err)
	}
	if interval <= 0 {
		return 0, fmt.Errorf("display %q rotation_interval must be greater than zero", d.ID)
	}
	return interval, nil
}

// Validate checks the complete local configuration contract. Asset files are
// deliberately not opened here so a missing asset can be reported and skipped
// independently at playback time.
func (c Config) Validate() error {
	var problems []error
	if c.Version != 1 {
		problems = append(problems, fmt.Errorf("version must be 1, got %d", c.Version))
	}
	switch strings.ToLower(strings.TrimSpace(c.LogLevel)) {
	case "debug", "info", "warn", "error":
	default:
		problems = append(problems, fmt.Errorf("log_level must be debug, info, warn, or error"))
	}
	if strings.TrimSpace(c.Cache.Directory) == "" {
		problems = append(problems, errors.New("cache.directory is required"))
	}
	if c.Cache.MaxBytes <= 0 {
		problems = append(problems, errors.New("cache.max_bytes must be greater than zero"))
	}
	if strings.TrimSpace(c.Output.Directory) == "" {
		problems = append(problems, errors.New("output.directory is required"))
	}
	if len(c.Playlists) == 0 {
		problems = append(problems, errors.New("at least one playlist is required"))
	}
	if len(c.Displays) == 0 {
		problems = append(problems, errors.New("at least one display is required"))
	}

	playlists := make(map[string]struct{}, len(c.Playlists))
	for i, playlist := range c.Playlists {
		if strings.TrimSpace(playlist.ID) == "" {
			problems = append(problems, fmt.Errorf("playlists[%d].id is required", i))
		} else if _, exists := playlists[playlist.ID]; exists {
			problems = append(problems, fmt.Errorf("playlist id %q is duplicated", playlist.ID))
		} else {
			playlists[playlist.ID] = struct{}{}
		}
		if len(playlist.Assets) == 0 {
			problems = append(problems, fmt.Errorf("playlist %q must contain at least one asset", playlist.ID))
		}
		for j, asset := range playlist.Assets {
			if strings.TrimSpace(asset.Path) == "" {
				problems = append(problems, fmt.Errorf("playlists[%d].assets[%d].path is required", i, j))
			}
			if asset.SHA256 != "" {
				decoded, err := hex.DecodeString(asset.SHA256)
				if err != nil || len(decoded) != 32 {
					problems = append(problems, fmt.Errorf("playlists[%d].assets[%d].sha256 must be a 64-character hexadecimal SHA-256 digest", i, j))
				}
			}
		}
	}

	displays := make(map[string]struct{}, len(c.Displays))
	for i, display := range c.Displays {
		if strings.TrimSpace(display.ID) == "" {
			problems = append(problems, fmt.Errorf("displays[%d].id is required", i))
		} else if _, exists := displays[display.ID]; exists {
			problems = append(problems, fmt.Errorf("display id %q is duplicated", display.ID))
		} else {
			displays[display.ID] = struct{}{}
		}
		if strings.TrimSpace(display.PlaylistID) == "" {
			problems = append(problems, fmt.Errorf("displays[%d].playlist_id is required", i))
		} else if _, exists := playlists[display.PlaylistID]; !exists {
			problems = append(problems, fmt.Errorf("display %q references unknown playlist %q", display.ID, display.PlaylistID))
		}
		if _, err := display.Interval(); err != nil {
			problems = append(problems, err)
		}
	}

	return errors.Join(problems...)
}

// Load decodes strict JSON, validates it, and resolves every configured path
// relative to the configuration file's directory.
func Load(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open config: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return Config{}, errors.New("decode config: multiple JSON values")
		}
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("validate config: %w", err)
	}

	base, err := filepath.Abs(filepath.Dir(path))
	if err != nil {
		return Config{}, fmt.Errorf("resolve config directory: %w", err)
	}
	cfg.Cache.Directory = resolvePath(base, cfg.Cache.Directory)
	cfg.Output.Directory = resolvePath(base, cfg.Output.Directory)
	for i := range cfg.Playlists {
		for j := range cfg.Playlists[i].Assets {
			cfg.Playlists[i].Assets[j].Path = resolvePath(base, cfg.Playlists[i].Assets[j].Path)
		}
	}
	return cfg, nil
}

func resolvePath(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Clean(filepath.Join(base, path))
}
