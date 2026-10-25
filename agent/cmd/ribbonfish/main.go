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
	"syscall"

	"github.com/CyanAutomation/ribbonfish/agent/internal/agent"
	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/drm"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/logging"
)

func main() {
	configPath := flag.String("config", defaultConfigPath(), "path to the agent JSON configuration")
	listDisplays := flag.Bool("list-displays", false, "list DRM/KMS connectors from Linux sysfs and exit")
	flag.Parse()
	if *listDisplays {
		if err := listDRMDisplays("/sys/class/drm", "/dev/dri", os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "ribbonfish:", err)
			os.Exit(1)
		}
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
	if path := os.Getenv("RIBBONFISH_CONFIG_FILE"); path != "" {
		return path
	}
	return "config.json"
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
	outputBackend, err := newDisplayOutput(cfg)
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
	runErr := playback.Run(ctx)
	outputErr := outputBackend.Close()
	cacheErr := imageCache.Close()
	logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
	return errors.Join(runErr, outputErr, cacheErr)
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
