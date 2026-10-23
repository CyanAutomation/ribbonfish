package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
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

// run loads the typed contract and waits for cancellation. Runtime backends
// are composed here as they are introduced in the following implementation
// layers; the signal lifecycle is already exercised by this foundation.
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
	<-ctx.Done()
	logger.Info("agent shutdown complete", "reason", context.Cause(ctx))
	return nil
}
