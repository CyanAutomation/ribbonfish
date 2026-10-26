// Package config defines and validates the agent's local configuration
// contract. It intentionally contains no control-plane settings.
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

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

// Config describes the local, offline-capable agent. Paths are resolved
// relative to the config file by Load.
type Config struct {
	Version  int             `json:"version"`
	LogLevel string          `json:"log_level"`
	Cache    CacheConfig     `json:"cache"`
	Output   OutputConfig    `json:"output"`
	Playlist PlaylistConfig  `json:"playlist"`
	Displays []DisplayConfig `json:"displays"`
}

type CacheConfig struct {
	Directory string `json:"directory"`
	MaxBytes  int64  `json:"max_bytes"`
}

type OutputConfig struct {
	Backend   string `json:"backend,omitempty"`
	Directory string `json:"directory"`
	Device    string `json:"device,omitempty"`
	Fit       string `json:"fit,omitempty"`
}

type PlaylistConfig struct {
	ID               string        `json:"id"`
	RotationInterval string        `json:"rotation_interval"`
	Assets           []AssetConfig `json:"assets"`
}

type AssetConfig struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
}

type DisplayConfig struct {
	ID        string `json:"id"`
	Connector string `json:"connector,omitempty"`
	Mode      string `json:"mode,omitempty"`
}

// EffectiveBackend preserves the original local config contract by selecting
// the software simulator when no backend is specified.
func (c OutputConfig) EffectiveBackend() string {
	backend := strings.ToLower(strings.TrimSpace(c.Backend))
	if backend == "" {
		return "simulator"
	}
	return backend
}

// EffectiveFit returns the default image fit behavior.
func (c OutputConfig) EffectiveFit() string {
	fit := strings.ToLower(strings.TrimSpace(c.Fit))
	if fit == "" {
		return "contain"
	}
	return fit
}

// Interval parses the globally active playlist's rotation interval.
func (p PlaylistConfig) Interval() (time.Duration, error) {
	interval, err := time.ParseDuration(p.RotationInterval)
	if err != nil {
		return 0, fmt.Errorf("playlist %q rotation_interval: %w", p.ID, err)
	}
	if interval <= 0 {
		return 0, fmt.Errorf("playlist %q rotation_interval must be greater than zero", p.ID)
	}
	return interval, nil
}

// Validate checks the complete local configuration contract. Asset files are
// deliberately not opened here so a missing asset can be reported and skipped
// independently at playback time.
func (c Config) Validate() error {
	var problems []error
	if c.Version != 2 {
		problems = append(problems, fmt.Errorf("version must be 2, got %d", c.Version))
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
	backend := c.Output.EffectiveBackend()
	switch backend {
	case "simulator":
		if strings.TrimSpace(c.Output.Directory) == "" {
			problems = append(problems, errors.New("output.directory is required"))
		}
	case "drm":
		if strings.TrimSpace(c.Output.Device) == "" {
			problems = append(problems, errors.New("output.device is required when output.backend is drm"))
		} else if !filepath.IsAbs(c.Output.Device) {
			problems = append(problems, errors.New("output.device must be an absolute path"))
		}
	default:
		problems = append(problems, errors.New(`output.backend must be "simulator" or "drm"`))
	}
	if fit := c.Output.EffectiveFit(); fit != "contain" && fit != "cover" && fit != "stretch" {
		problems = append(problems, errors.New(`output.fit must be "contain", "cover", or "stretch"`))
	}
	if strings.TrimSpace(c.Playlist.ID) == "" {
		problems = append(problems, errors.New("playlist.id is required"))
	} else if !validIdentifier(c.Playlist.ID) {
		problems = append(problems, errors.New("playlist.id contains unsupported characters"))
	}
	if len(c.Playlist.Assets) == 0 {
		problems = append(problems, errors.New("playlist must contain at least one asset"))
	}
	if _, err := c.Playlist.Interval(); err != nil {
		problems = append(problems, err)
	}
	if len(c.Displays) == 0 {
		problems = append(problems, errors.New("at least one display is required"))
	}

	for i, asset := range c.Playlist.Assets {
		if strings.TrimSpace(asset.Path) == "" {
			problems = append(problems, fmt.Errorf("playlist.assets[%d].path is required", i))
		}
		if asset.SHA256 != "" {
			decoded, err := hex.DecodeString(asset.SHA256)
			if err != nil || len(decoded) != 32 {
				problems = append(problems, fmt.Errorf("playlist.assets[%d].sha256 must be a 64-character hexadecimal SHA-256 digest", i))
			}
		}
	}

	displays := make(map[string]struct{}, len(c.Displays))
	connectors := make(map[string]struct{}, len(c.Displays))
	for i, display := range c.Displays {
		if strings.TrimSpace(display.ID) == "" {
			problems = append(problems, fmt.Errorf("displays[%d].id is required", i))
		} else if !validIdentifier(display.ID) {
			problems = append(problems, fmt.Errorf("displays[%d].id contains unsupported characters", i))
		} else if _, exists := displays[display.ID]; exists {
			problems = append(problems, fmt.Errorf("display id %q is duplicated", display.ID))
		} else {
			displays[display.ID] = struct{}{}
		}
		if display.Connector != "" && !validIdentifier(display.Connector) {
			problems = append(problems, fmt.Errorf("displays[%d].connector contains unsupported characters", i))
		}
		if backend == "drm" {
			if strings.TrimSpace(display.Connector) == "" {
				problems = append(problems, fmt.Errorf("display %q requires connector when output.backend is drm", display.ID))
			} else if _, exists := connectors[display.Connector]; exists {
				problems = append(problems, fmt.Errorf("connector %q is assigned to more than one display", display.Connector))
			} else {
				connectors[display.Connector] = struct{}{}
			}
		}
		if _, err := display.ParseMode(); err != nil {
			problems = append(problems, err)
		}
	}

	return errors.Join(problems...)
}

// ParseMode validates and returns a display's requested mode.
func (d DisplayConfig) ParseMode() (display.ModeSpec, error) {
	mode, err := display.ParseMode(d.Mode)
	if err != nil {
		return display.ModeSpec{}, fmt.Errorf("display %q mode: %w", d.ID, err)
	}
	return mode, nil
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
	if value := strings.TrimSpace(os.Getenv("RIBBONFISH_CACHE_DIR")); value != "" {
		cfg.Cache.Directory = value
	}
	if cfg.Output.EffectiveBackend() == "drm" {
		if value := strings.TrimSpace(os.Getenv("RIBBONFISH_DRM_DEVICE")); value != "" {
			cfg.Output.Device = value
		}
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
	for i := range cfg.Playlist.Assets {
		cfg.Playlist.Assets[i].Path = resolvePath(base, cfg.Playlist.Assets[i].Path)
	}
	return cfg, nil
}

func resolvePath(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Clean(filepath.Join(base, path))
}

func validIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 64 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for i := 1; i < len(value); i++ {
		c := value[i]
		if !isASCIIAlphaNumeric(c) && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}
