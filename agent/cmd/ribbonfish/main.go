package main

import (
	"context"
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
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/logging"
)

func main() {
	configPath := flag.String("config", "config.json", "path to the agent JSON configuration")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *configPath, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "ribbonfish:", err)
		os.Exit(1)
	}
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
	outputBackend, err := simulator.NewSimulator(cfg.Output.Directory)
	if err != nil {
		_ = imageCache.Close()
		return fmt.Errorf("start simulator: %w", err)
	}
	playback, err := agent.New(ctx, cfg, imageCache, outputBackend, logger, agent.RealClock{})
	if err != nil {
		_ = outputBackend.Close()
		_ = imageCache.Close()
		return err
	}
	logger.Info("agent started", "display_backend", "simulator")
	runErr := playback.Run(ctx)
	outputErr := outputBackend.Close()
	cacheErr := imageCache.Close()
	logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
	return errors.Join(runErr, outputErr, cacheErr)
}
