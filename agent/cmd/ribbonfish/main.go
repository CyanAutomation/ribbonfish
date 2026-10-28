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
	checkDisplays := flag.Bool("check-displays", false, "check configured DRM connectors against Linux sysfs without changing display state")
	enroll := flag.Bool("enroll", false, "exchange a one-time code from stdin for a per-device sync credential")
	flag.Parse()
	if *listDisplays {
		if err := listDRMDisplays("/sys/class/drm", "/dev/dri", os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "ribbonfish:", err)
			os.Exit(1)
		}
		return
	}
	if *checkDisplays {
		if err := checkDRMDisplays(*configPath, "/sys/class/drm", "/dev/dri", os.Stdout); err != nil {
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
	case "pi3a-plus", "pi3b", "pi4", "simulator", "simulator-pi3a-plus", "simulator-pi3b", "simulator-pi4":
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

func deviceKeyPath() string {
	if value := strings.TrimSpace(os.Getenv("RIBBONFISH_DEVICE_KEY_FILE")); value != "" {
		return value
	}
	return "/var/lib/ribbonfish/device-key"
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

func checkDRMDisplays(configPath, sysfsRoot, devRoot string, output io.Writer) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	if cfg.Output.EffectiveBackend() != "drm" {
		return fmt.Errorf("display check requires output.backend=drm, got %q", cfg.Output.EffectiveBackend())
	}
	connectors, err := drm.Discover(sysfsRoot, devRoot)
	if err != nil {
		return err
	}
	targets := make([]drm.DisplayTarget, 0, len(cfg.Displays))
	for _, target := range cfg.Displays {
		targets = append(targets, drm.DisplayTarget{ID: target.ID, Connector: target.Connector, Mode: target.Mode})
	}
	if err := drm.ValidateTargets(cfg.Output.Device, targets, connectors); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(output, "DRM display preflight passed: device=%s displays=%d\n", cfg.Output.Device, len(targets)); err != nil {
		return fmt.Errorf("write DRM display check result: %w", err)
	}
	for _, target := range targets {
		for _, connector := range connectors {
			if connector.Name != target.Connector {
				continue
			}
			if _, err := fmt.Fprintf(output, "display_id=%s connector=%s status=%s requested_mode=%s advertised_modes=%d\n", target.ID, connector.Name, connector.Status, target.Mode, len(connector.Modes)); err != nil {
				return fmt.Errorf("write DRM display check result: %w", err)
			}
			break
		}
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
	logger.Info("agent configuration loaded", "displays", len(cfg.Displays), "playlist_id", cfg.Playlist.ID)
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
		logger.Info("last-good remote content loaded", "revision", snapshot.Snapshot.Revision)
	} else if !errors.Is(loadErr, os.ErrNotExist) {
		logger.Warn("last-good remote content is unavailable; using bundled content", "error", loadErr)
	}
	syncURL := strings.TrimSpace(os.Getenv("RIBBONFISH_SYNC_URL"))
	deviceID := strings.TrimSpace(os.Getenv("RIBBONFISH_DEVICE_ID"))
	var legacySynchronizer syncer.Synchronizer
	var deviceKey *syncer.DeviceKey
	var pairingState *display.PairingState
	if syncURL != "" {
		token, tokenErr := syncer.ReadDeviceToken(deviceTokenPath())
		if tokenErr == nil {
			if synchronizer, createErr := syncer.NewHTTPClient(syncURL, deviceID, token, imageCache, nil); createErr != nil {
				logger.Warn("remote sync configuration is invalid; continuing with local content", "error", createErr)
			} else {
				legacySynchronizer = synchronizer
			}
		} else if errors.Is(tokenErr, os.ErrNotExist) {
			if deviceID == "" {
				logger.Warn("remote sync is configured but RIBBONFISH_DEVICE_ID is missing; continuing with local content")
			} else if key, keyErr := syncer.LoadOrCreateDeviceKey(deviceKeyPath()); keyErr != nil {
				logger.Warn("automatic device enrollment is unavailable; continuing with local content", "error", keyErr)
			} else {
				deviceKey = key
				pairingState = display.NewPairingState(deviceID, key.Fingerprint())
				logger.Info("device identity is ready; waiting for management approval", "device_id", deviceID, "fingerprint", key.Fingerprint())
			}
		} else {
			logger.Warn("remote sync is configured but device credential is invalid; continuing with local content", "error", tokenErr)
		}
	}
	outputBackend, err := newDisplayOutput(hardwareConfig)
	if err != nil {
		_ = imageCache.Close()
		return fmt.Errorf("start %s: %w", cfg.Output.EffectiveBackend(), err)
	}
	if pairingState != nil {
		outputBackend = display.NewPairingOutput(outputBackend, pairingState)
	}
	playback, err := agent.New(ctx, cfg, imageCache, outputBackend, logger, agent.RealClock{})
	if err != nil {
		_ = outputBackend.Close()
		_ = imageCache.Close()
		return err
	}
	logger.Info("agent started", "display_backend", cfg.Output.EffectiveBackend())
	var syncDone chan error
	if legacySynchronizer != nil {
		if synchronizer, ok := legacySynchronizer.(*syncer.HTTPClient); ok && activeSnapshot != nil {
			synchronizer.SetETag(activeSnapshot.ETag)
		}
		syncDone = make(chan error, 1)
		go func() {
			syncDone <- runSyncLoop(ctx, legacySynchronizer, hardwareConfig, playback, snapshotPath, activeSnapshot, logger)
		}()
	} else if deviceKey != nil {
		syncDone = make(chan error, 1)
		go func() {
			syncDone <- runDeviceEnrollmentLoop(ctx, syncURL, deviceID, deviceKey, imageCache, hardwareConfig, playback, snapshotPath, activeSnapshot, pairingState, logger)
		}()
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

func runDeviceEnrollmentLoop(ctx context.Context, syncURL, deviceID string, key *syncer.DeviceKey, store cache.Store, hardware config.Config, playback syncPlayback, snapshotPath string, activeSnapshot *syncer.Update, pairing *display.PairingState, logger interface {
	Info(string, ...any)
	Warn(string, ...any)
}) error {
	interval := configuredSyncInterval(logger)
	retryDelay := 5 * time.Second
	lastStatus := ""
	for ctx.Err() == nil {
		status, err := syncer.RequestDeviceEnrollment(ctx, syncURL, deviceID, key, nil)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			logger.Warn("automatic enrollment request failed; retrying", "error", err)
			if !waitForContext(ctx, retryDelay) {
				return nil
			}
			if retryDelay < 5*time.Minute/2 {
				retryDelay *= 2
			} else {
				retryDelay = 5 * time.Minute
			}
			continue
		}
		retryDelay = 5 * time.Second
		if status.Status != lastStatus {
			switch status.Status {
			case "pending":
				logger.Info("device is waiting for management approval", "device_id", deviceID)
			case "rejected":
				logger.Warn("device enrollment was rejected", "device_id", deviceID)
			case "disabled":
				logger.Warn("device is approved but disabled; enable it in management", "device_id", deviceID)
			}
			lastStatus = status.Status
		}
		switch status.Status {
		case "pending":
			pairing.SetStatus("pending")
		case "rejected":
			pairing.SetStatus("rejected")
		case "disabled":
			pairing.SetStatus("disabled")
		case "approved":
			pairing.Clear()
			synchronizer, err := syncer.NewKeyHTTPClient(syncURL, deviceID, key, store, nil)
			if err != nil {
				return fmt.Errorf("configure key-based synchronization: %w", err)
			}
			if activeSnapshot != nil {
				synchronizer.SetETag(activeSnapshot.ETag)
			}
			logger.Info("device enrollment approved; starting playlist sync", "device_id", deviceID)
			return runSyncLoop(ctx, synchronizer, hardware, playback, snapshotPath, activeSnapshot, logger)
		}
		if !waitForContext(ctx, interval) {
			return nil
		}
	}
	return nil
}

func configuredSyncInterval(logger interface{ Warn(string, ...any) }) time.Duration {
	if value := strings.TrimSpace(os.Getenv("RIBBONFISH_SYNC_INTERVAL")); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil && parsed > 0 {
			return parsed
		}
		logger.Warn("invalid RIBBONFISH_SYNC_INTERVAL; using one minute", "value", value)
	}
	return time.Minute
}

func waitForContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

type syncPlayback interface {
	CurrentConfig() config.Config
	ApplyConfig(context.Context, config.Config) error
}

func runSyncLoop(ctx context.Context, synchronizer syncer.Synchronizer, hardware config.Config, playback syncPlayback, snapshotPath string, activeSnapshot *syncer.Update, logger interface {
	Info(string, ...any)
	Warn(string, ...any)
}) error {
	interval := configuredSyncInterval(logger)
	retryDelay := 5 * time.Second
	syncHealthy := false
	for ctx.Err() == nil {
		delay := interval
		update, err := synchronizer.Synchronize(ctx, hardware, playback.CurrentConfig())
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			syncHealthy = false
			logger.Warn("remote synchronization failed; keeping last good content", "error", err)
			delay = retryDelay
			if retryDelay < 5*time.Minute/2 {
				retryDelay *= 2
			} else {
				retryDelay = 5 * time.Minute
			}
		} else if update.Changed {
			syncHealthy = false
			previous := activeSnapshot
			previousConfig := playback.CurrentConfig()
			if err := syncer.SaveSnapshot(snapshotPath, update); err != nil {
				logger.Warn("could not persist remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good snapshot", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else if err := playback.ApplyConfig(ctx, update.Config); err != nil {
				logger.Warn("could not activate remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good snapshot", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else {
				activeSnapshot = &update
				logger.Info("remote content snapshot activated", "revision", update.Snapshot.Revision)
				syncHealthy = true
				retryDelay = 5 * time.Second
			}
		} else {
			retryDelay = 5 * time.Second
			if !syncHealthy {
				logger.Info("remote synchronization succeeded", "etag", update.ETag, "changed", update.Changed)
			}
			syncHealthy = true
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
			return fmt.Errorf("remove rejected last-good snapshot: %w", err)
		}
		directory, err := os.Open(filepath.Dir(path))
		if err != nil {
			return fmt.Errorf("open last-good snapshot directory: %w", err)
		}
		defer directory.Close()
		if err := directory.Sync(); err != nil {
			return fmt.Errorf("sync last-good snapshot directory: %w", err)
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
