package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/agent"
	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/drm"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/health"
	"github.com/CyanAutomation/ribbonfish/agent/internal/logging"
	"github.com/CyanAutomation/ribbonfish/agent/internal/syncer"
)

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to the agent JSON configuration")
	listDisplays := flag.Bool("list-displays", false, "list DRM/KMS connectors from Linux sysfs and exit")
	checkDisplays := flag.Bool("check-displays", false, "check configured DRM connectors, warning for disconnected outputs")
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
	case "pi3a-plus", "pi3b", "pi4", "pi4-single", "simulator", "simulator-pi3a-plus", "simulator-pi3b", "simulator-pi4":
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
	unavailable, err := drm.ValidateTargetsAllowDisconnected(cfg.Output.Device, targets, connectors)
	if err != nil {
		return err
	}
	if len(unavailable) == 0 {
		if _, err := fmt.Fprintf(output, "DRM display preflight passed: device=%s displays=%d\n", cfg.Output.Device, len(targets)); err != nil {
			return fmt.Errorf("write DRM display check result: %w", err)
		}
	} else if _, err := fmt.Fprintf(output, "DRM display preflight found disconnected outputs: device=%s displays=%d\n", cfg.Output.Device, len(targets)); err != nil {
		return fmt.Errorf("write DRM display check result: %w", err)
	}
	for _, target := range targets {
		for _, connector := range connectors {
			if connector.Name != target.Connector {
				continue
			}
			if connector.Status == "disconnected" {
				if _, err := fmt.Fprintf(output, "warning: display_id=%s connector=%s is disconnected; agent will continue without it\n", target.ID, connector.Name); err != nil {
					return fmt.Errorf("write DRM display check result: %w", err)
				}
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
	healthSpecs := make([]health.OutputSpec, 0, len(hardwareConfig.Displays))
	for _, item := range hardwareConfig.Displays {
		healthSpecs = append(healthSpecs, health.OutputSpec{DisplayID: item.ID, Connector: item.Connector})
	}
	healthTracker := health.NewTracker(currentAgentVersion(), hardwareConfig.Cache.Directory, healthSpecs, time.Now)
	snapshotPath := filepath.Join(cfg.Cache.Directory, "last-good.json")
	var activeSnapshot *syncer.Update
	if snapshot, loadErr := syncer.LoadSnapshot(snapshotPath, hardwareConfig, imageCache); loadErr == nil {
		cfg = snapshot.Config
		activeSnapshot = &snapshot
		healthTracker.SetAppliedSnapshot(snapshot.Snapshot.ID, snapshot.Snapshot.Revision)
		logger.Info("last-good remote content loaded", "revision", snapshot.Snapshot.Revision)
	} else if !errors.Is(loadErr, os.ErrNotExist) {
		logger.Warn("last-good remote content is unavailable; using bundled content", "error", loadErr)
	}
	syncURL := strings.TrimSpace(os.Getenv("RIBBONFISH_SYNC_URL"))
	deviceID := strings.TrimSpace(os.Getenv("RIBBONFISH_DEVICE_ID"))
	var legacySynchronizer syncer.Synchronizer
	var deviceKey *syncer.DeviceKey
	var pairingState *display.PairingState
	var healthClient *syncer.HealthClient
	if syncURL != "" {
		token, tokenErr := syncer.ReadDeviceToken(deviceTokenPath())
		if tokenErr == nil {
			if synchronizer, createErr := syncer.NewHTTPClient(syncURL, deviceID, token, imageCache, nil); createErr != nil {
				logger.Warn("remote sync configuration is invalid; continuing with local content", "error", createErr)
			} else {
				legacySynchronizer = synchronizer
				if client, clientErr := syncer.NewHealthClient(syncURL, deviceID, token, nil, nil); clientErr == nil {
					healthClient = client
				} else {
					logger.Warn("remote health reporting is unavailable", "error", clientErr)
				}
			}
		} else if errors.Is(tokenErr, os.ErrNotExist) {
			if deviceID == "" {
				logger.Warn("remote sync is configured but RIBBONFISH_DEVICE_ID is missing; continuing with local content")
			} else if key, keyErr := syncer.LoadOrCreateDeviceKey(deviceKeyPath()); keyErr != nil {
				logger.Warn("automatic device enrollment is unavailable; continuing with local content", "error", keyErr)
			} else {
				deviceKey = key
				if client, clientErr := syncer.NewHealthClient(syncURL, deviceID, "", key, nil); clientErr == nil {
					healthClient = client
				} else {
					logger.Warn("remote health reporting is unavailable", "error", clientErr)
				}
				pairingState = display.NewPairingState(deviceID, key.Fingerprint())
				logger.Info("device identity is ready; waiting for management approval", "device_id", deviceID, "fingerprint", key.Fingerprint())
			}
		} else {
			logger.Warn("remote sync is configured but device credential is invalid; continuing with local content", "error", tokenErr)
		}
	}
	var healthReady = make(chan struct{})
	var healthReadyOnce sync.Once
	markHealthReady := func() { healthReadyOnce.Do(func() { close(healthReady) }) }
	if legacySynchronizer != nil {
		markHealthReady()
		if healthClient != nil {
			bestEffortHealthReport(healthClient, healthTracker)
		}
	}
	outputBackend, err := newDisplayOutput(hardwareConfig)
	if err != nil {
		healthTracker.SetStartupFailure(startupErrorCode(err))
		if healthClient != nil && legacySynchronizer != nil {
			reportStartupHealth(ctx, healthClient, healthTracker, logger)
		}
		_ = imageCache.Close()
		return fmt.Errorf("start %s: %w", cfg.Output.EffectiveBackend(), err)
	}
	reportUnavailableDisplays(outputBackend, healthTracker, logger)
	if pairingState != nil {
		outputBackend = display.NewPairingOutput(outputBackend, pairingState)
	}
	playback, err := agent.New(ctx, cfg, imageCache, outputBackend, logger, agent.RealClock{})
	if err != nil {
		healthTracker.SetStartupFailure("configuration_invalid")
		if healthClient != nil && legacySynchronizer != nil {
			reportStartupHealth(ctx, healthClient, healthTracker, logger)
		}
		_ = outputBackend.Close()
		_ = imageCache.Close()
		return err
	}
	playback.SetHealthTracker(healthTracker)
	healthTracker.SetState("ready")
	logger.Info("agent started", "display_backend", cfg.Output.EffectiveBackend())
	var healthDone chan struct{}
	if healthClient != nil {
		healthDone = make(chan struct{})
		go func() {
			defer close(healthDone)
			runHealthReporterLoop(ctx, healthReady, healthClient, healthTracker, logger)
		}()
	}
	var syncDone chan error
	if legacySynchronizer != nil {
		if synchronizer, ok := legacySynchronizer.(*syncer.HTTPClient); ok && activeSnapshot != nil {
			synchronizer.SetETag(activeSnapshot.ETag)
		}
		syncDone = make(chan error, 1)
		go func() {
			syncDone <- runSyncLoop(ctx, legacySynchronizer, hardwareConfig, playback, snapshotPath, activeSnapshot, healthTracker, logger)
		}()
	} else if deviceKey != nil {
		syncDone = make(chan error, 1)
		go func() {
			syncDone <- runDeviceEnrollmentLoop(ctx, syncURL, deviceID, deviceKey, imageCache, hardwareConfig, playback, snapshotPath, activeSnapshot, pairingState, healthTracker, healthReady, logger)
		}()
	}
	runErr := playback.Run(ctx)
	healthTracker.SetState("stopping")
	if healthClient != nil {
		select {
		case <-healthReady:
			if healthDone != nil {
				<-healthDone
			}
			bestEffortHealthReport(healthClient, healthTracker)
		default:
		}
	}
	if syncDone != nil {
		<-syncDone
	}
	outputErr := outputBackend.Close()
	cacheErr := imageCache.Close()
	logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
	return errors.Join(runErr, outputErr, cacheErr)
}

func currentAgentVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" && len(setting.Value) >= 12 {
				return setting.Value[:12]
			}
		}
	}
	return "dev"
}

func startupErrorCode(err error) string {
	if code := health.ErrorCode(err); code != "unknown" {
		return code
	}
	return "display_start_failed"
}

type healthWarningLogger interface{ Warn(string, ...any) }

func reportStartupHealth(ctx context.Context, client *syncer.HealthClient, tracker *health.Tracker, logger healthWarningLogger) {
	err := retryHealthReport(ctx, func(attemptCtx context.Context) error {
		return client.Report(attemptCtx, tracker.Snapshot(time.Now()))
	}, logger, 3, time.Second)
	if err != nil && (ctx == nil || ctx.Err() == nil) {
		logger.Warn("startup health report could not be delivered after retries", "error", err)
	}
}

func retryHealthReport(parent context.Context, report func(context.Context) error, logger healthWarningLogger, attempts int, retryDelay time.Duration) error {
	if parent == nil {
		return errors.New("health report context is required")
	}
	if attempts < 1 {
		return errors.New("health report attempts must be positive")
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := parent.Err(); err != nil {
			return err
		}
		attemptCtx, cancel := context.WithTimeout(parent, 2*time.Second)
		err := report(attemptCtx)
		cancel()
		if err == nil {
			return nil
		}
		if err := parent.Err(); err != nil {
			return err
		}
		lastErr = err
		if attempt == attempts {
			break
		}
		logger.Warn("startup health report failed; retrying", "attempt", attempt, "error", err)
		if retryDelay > 0 {
			timer := time.NewTimer(retryDelay)
			select {
			case <-parent.Done():
				timer.Stop()
				return parent.Err()
			case <-timer.C:
			}
		}
	}
	return lastErr
}

func bestEffortHealthReport(client *syncer.HealthClient, tracker *health.Tracker) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = client.Report(ctx, tracker.Snapshot(time.Now()))
}

func runHealthReporterLoop(ctx context.Context, ready <-chan struct{}, client *syncer.HealthClient, tracker *health.Tracker, logger healthWarningLogger) {
	select {
	case <-ready:
	case <-ctx.Done():
		return
	}
	report := func() {
		if err := client.Report(ctx, tracker.Snapshot(time.Now())); err != nil && ctx.Err() == nil {
			logger.Warn("device health report failed; retrying on the next interval or state change", "error", err)
		}
	}
	report()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			report()
		case <-tracker.Changes():
			report()
		}
	}
}

func runDeviceEnrollmentLoop(ctx context.Context, syncURL, deviceID string, key *syncer.DeviceKey, store cache.Store, hardware config.Config, playback syncPlayback, snapshotPath string, activeSnapshot *syncer.Update, pairing *display.PairingState, tracker *health.Tracker, healthReady chan struct{}, logger interface {
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
			if healthReady != nil {
				close(healthReady)
			}
			return runSyncLoop(ctx, synchronizer, hardware, playback, snapshotPath, activeSnapshot, tracker, logger)
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

func syncErrorCode(err error) string {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "unexpected http status 400") || strings.Contains(message, "unexpected http status 401") ||
		strings.Contains(message, "unexpected http status 403") || strings.Contains(message, "validate snapshot") ||
		strings.Contains(message, "decode snapshot") || strings.Contains(message, "etag") {
		return "sync_rejected"
	}
	return "sync_unavailable"
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

func runSyncLoop(ctx context.Context, synchronizer syncer.Synchronizer, hardware config.Config, playback syncPlayback, snapshotPath string, activeSnapshot *syncer.Update, tracker *health.Tracker, logger interface {
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
			if tracker != nil {
				tracker.SetSyncFailure(syncErrorCode(err))
			}
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
				if tracker != nil {
					tracker.SetSyncFailure("sync_unavailable")
				}
				logger.Warn("could not persist remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good snapshot", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else if err := playback.ApplyConfig(ctx, update.Config); err != nil {
				if tracker != nil {
					tracker.SetSyncFailure("sync_rejected")
				}
				logger.Warn("could not activate remote content; keeping last good content", "error", err)
				if restoreErr := restoreSnapshot(snapshotPath, previous); restoreErr != nil {
					logger.Warn("could not restore last-good snapshot", "error", restoreErr)
				}
				rollbackETag(synchronizer, previous)
				restoreActivePins(ctx, synchronizer, previousConfig)
			} else {
				activeSnapshot = &update
				if tracker != nil {
					tracker.SetSyncSuccess(update.Snapshot.ID, update.Snapshot.Revision)
				}
				logger.Info("remote content snapshot activated", "revision", update.Snapshot.Revision)
				syncHealthy = true
				retryDelay = 5 * time.Second
			}
		} else {
			retryDelay = 5 * time.Second
			if tracker != nil {
				playlistID := playback.CurrentConfig().Playlist.ID
				revision := ""
				if activeSnapshot != nil {
					revision = activeSnapshot.Snapshot.Revision
				}
				tracker.SetSyncSuccess(playlistID, revision)
			}
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

func reportUnavailableDisplays(outputBackend display.Output, tracker *health.Tracker, logger *slog.Logger) {
	outputStatus, ok := outputBackend.(interface{ UnavailableDisplays() []drm.DisplayTarget })
	if !ok {
		return
	}
	for _, item := range outputStatus.UnavailableDisplays() {
		logger.Warn("configured display connector is disconnected; continuing without it", "display_id", item.ID, "connector", item.Connector)
		tracker.SetOutputState(item.ID, "failed", "connector_disconnected")
	}
}
