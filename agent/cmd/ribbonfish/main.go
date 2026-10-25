package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/agent"
	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/drm"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/logging"
	"github.com/CyanAutomation/ribbonfish/agent/internal/syncer"
)

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to the agent JSON configuration")
	listDisplays := flag.Bool("list-displays", false, "list DRM/KMS connectors from Linux sysfs and exit")
	enroll := flag.Bool("enroll", false, "exchange a one-time code from stdin for a per-device sync credential")
	flag.Parse()
	if *listDisplays {
		if err := listDRMDisplays("/sys/class/drm", "/dev/dri", os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "ribbonfish:", err)
			os.Exit(1)
		}
		return
	}
	if *enroll {
		if err := enrollDevice(os.Getenv("RIBBONFISH_SYNC_URL"), os.Getenv("RIBBONFISH_DEVICE_ID"), deviceTokenPath(), os.Stdin); err != nil {
			fmt.Fprintln(os.Stderr, "ribbonfish:", err)
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "Ribbonfish device enrolled; credential stored in persistent device state.")
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *configPath, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "ribbonfish:", err)
		os.Exit(1)
	}
}

func defaultConfigPath() string {
	if override := strings.TrimSpace(os.Getenv("RIBBONFISH_CONFIG_FILE")); override != "" {
		return override
	}
	defaultsDir := strings.TrimSpace(os.Getenv("RIBBONFISH_DEFAULTS_DIR"))
	if defaultsDir == "" {
		defaultsDir = "/usr/share/ribbonfish/defaults"
	}
	profile := strings.TrimSpace(os.Getenv("RIBBONFISH_PROFILE"))
	switch profile {
	case "pi3a-plus", "pi3b", "pi4", "simulator", "simulator-pi3b", "simulator-pi4":
	default:
		profile = "pi4"
	}
	return filepath.Join(defaultsDir, profile+".json")
}

func deviceTokenPath() string {
	if value := strings.TrimSpace(os.Getenv("RIBBONFISH_DEVICE_TOKEN_FILE")); value != "" {
		return value
	}
	return "/var/lib/ribbonfish/device-token"
}

func enrollDevice(syncURL, deviceID, tokenFile string, input io.Reader) error {
	if strings.TrimSpace(syncURL) == "" {
		return errors.New("RIBBONFISH_SYNC_URL is required for enrollment")
	}
	codeBytes, err := io.ReadAll(io.LimitReader(input, 513))
	if err != nil {
		return fmt.Errorf("read one-time enrollment code: %w", err)
	}
	if len(codeBytes) > 512 {
		return errors.New("one-time enrollment code exceeds 512 bytes")
	}
	token, err := syncer.Enroll(context.Background(), syncURL, deviceID, string(codeBytes), nil)
	if err != nil {
		return err
	}
	if err := syncer.WriteDeviceToken(tokenFile, token); err != nil {
		return err
	}
	return nil
}

func listDRMDisplays(sysfsRoot, devRoot string, output io.Writer) error {
	connectors, err := drm.Discover(sysfsRoot, devRoot)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(connectors); err != nil {
		return fmt.Errorf("write DRM connector report: %w", err)
	}
	return nil
}

// run loads the typed contract, composes the local cache and simulator, and
// waits for graceful context cancellation.
func run(ctx context.Context, configPath string, output io.Writer) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	logger, err := logging.New(output, cfg.LogLevel)
	if err != nil {
		return err
	}
	logger.Info("agent configuration loaded", "displays", len(cfg.Displays), "playlists", len(cfg.Playlists))
	if ctx.Err() != nil {
		logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
		return nil
	}

	imageCache, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		return fmt.Errorf("open image cache: %w", err)
	}
	hardwareConfig := cfg
	snapshotPath := filepath.Join(cfg.Cache.Directory, "last-good.json")
	var activeSnapshot *syncer.Update
	if snapshot, loadErr := syncer.LoadSnapshot(snapshotPath, hardwareConfig, imageCache); loadErr == nil {
		cfg = snapshot.Config
		activeSnapshot = &snapshot
		logger.Info("last-good remote content loaded", "revision", snapshot.Manifest.Revision)
	} else if !errors.Is(loadErr, os.ErrNotExist) {
		logger.Warn("last-good remote content is unavailable; using bundled content", "error", loadErr)
	}
	outputBackend, err := newDisplayOutput(hardwareConfig)
	if err != nil {
		_ = imageCache.Close()
		return fmt.Errorf("start %s: %w", cfg.Output.EffectiveBackend(), err)
	}
	playback, err := agent.New(ctx, cfg, imageCache, outputBackend, logger, agent.RealClock{})
	if err != nil {
		_ = outputBackend.Close()
		_ = imageCache.Close()
		return err
	}
	logger.Info("agent started", "display_backend", cfg.Output.EffectiveBackend())
	var syncDone chan error
	if syncURL := strings.TrimSpace(os.Getenv("RIBBONFISH_SYNC_URL")); syncURL != "" {
		deviceID := strings.TrimSpace(os.Getenv("RIBBONFISH_DEVICE_ID"))
		token, tokenErr := syncer.ReadDeviceToken(deviceTokenPath())
		if tokenErr != nil {
			logger.Warn("remote sync is configured but device credential is unavailable; continuing with local content", "error", tokenErr)
		} else if synchronizer, createErr := syncer.NewHTTPClient(syncURL, deviceID, token, imageCache, nil); createErr != nil {
			logger.Warn("remote sync configuration is invalid; continuing with local content", "error", createErr)
		} else {
			if activeSnapshot != nil {
				synchronizer.SetETag(activeSnapshot.ETag)
			}
			syncDone = make(chan error, 1)
			go func() {
				syncDone <- runSyncLoop(ctx, synchronizer, hardwareConfig, playback, snapshotPath, activeSnapshot, logger)
			}()
		}
	}
	runErr := playback.Run(ctx)
	if syncDone != nil {
		<-syncDone
	}
	outputErr := outputBackend.Close()
	cacheErr := imageCache.Close()
	logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
	return errors.Join(runErr, outputErr, cacheErr)
}

func runSyncLoop(ctx context.Context, synchronizer syncer.Synchronizer, hardware config.Config, playback *agent.Agent, snapshotPath string, activeSnapshot *syncer.Update, logger interface {
	Info(string, ...any)
	Warn(string, ...any)
}) error {
	interval := time.Minute
	if value := strings.TrimSpace(os.Getenv("RIBBONFISH_SYNC_INTERVAL")); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
			interval = parsed
		} else {
			logger.Warn("invalid RIBBONFISH_SYNC_INTERVAL; using one minute", "value", value)
		}
	}
	retryDelay := 5 * time.Second
	for ctx.Err() == nil {
		delay := interval
		update, err := synchronizer.Synchronize(ctx, hardware, playback.CurrentConfig())
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			logger.Warn("remote synchronization failed; keeping last good content", "error", err)
			delay = retryDelay
			if retryDelay < 5*time.Minute/2 {
				retryDelay *= 2
			} else {
				retryDelay = 5 * time.Minute
			}
		} else if update.Changed {
			previous := activeSnapshot
			previousConfig := playback.CurrentConfig()
			if err := syncer.SaveSnapshot(snapshotPath, update); err != nil {
				logger.Warn("could not persist remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good manifest", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else if err := playback.ApplyConfig(ctx, update.Config); err != nil {
				logger.Warn("could not activate remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good manifest", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else {
				activeSnapshot = &update
				logger.Info("remote content snapshot activated", "revision", update.Manifest.Revision)
				retryDelay = 5 * time.Second
			}
		} else {
			retryDelay = 5 * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil
		}
	}
	return nil
}

func rollbackETag(synchronizer syncer.Synchronizer, snapshot *syncer.Update) {
	if client, ok := synchronizer.(*syncer.HTTPClient); ok {
		if snapshot == nil {
			client.SetETag("")
		} else {
			client.SetETag(snapshot.ETag)
		}
	}
}

func restoreActivePins(ctx context.Context, synchronizer syncer.Synchronizer, active config.Config) {
	if client, ok := synchronizer.(*syncer.HTTPClient); ok {
		_ = client.RestoreActivePins(ctx, active)
	}
}

func restoreSnapshot(path string, snapshot *syncer.Update) error {
	if snapshot == nil {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove rejected last-good manifest: %w", err)
		}
		directory, err := os.Open(filepath.Dir(path))
		if err != nil {
			return fmt.Errorf("open last-good manifest directory: %w", err)
		}
		defer directory.Close()
		if err := directory.Sync(); err != nil {
			return fmt.Errorf("sync last-good manifest directory: %w", err)
		}
		return nil
	}
	return syncer.SaveSnapshot(path, *snapshot)
}

func newDisplayOutput(cfg config.Config) (display.Output, error) {
	fit := display.FitMode(cfg.Output.EffectiveFit())
	switch cfg.Output.EffectiveBackend() {
	case "simulator":
		profiles := make(map[string]display.ModeSpec, len(cfg.Displays))
		for _, target := range cfg.Displays {
			mode, err := target.ParseMode()
			if err != nil {
				return nil, err
			}
			if !mode.Preferred {
				profiles[target.ID] = mode
			}
		}
		return simulator.NewSimulatorWithProfiles(cfg.Output.Directory, profiles, fit)
	case "drm":
		targets := make([]drm.DisplayTarget, 0, len(cfg.Displays))
		for _, target := range cfg.Displays {
			targets = append(targets, drm.DisplayTarget{ID: target.ID, Connector: target.Connector, Mode: target.Mode})
		}
		return drm.NewOutput(cfg.Output.Device, targets, fit)
	default:
		return nil, fmt.Errorf("unsupported display backend %q", cfg.Output.EffectiveBackend())
	}
}
