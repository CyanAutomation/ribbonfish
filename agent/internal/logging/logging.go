// Package logging creates structured loggers for the device agent.
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"strings"
)

// New returns a text slog logger configured for the named level.
func New(output io.Writer, level string) (*slog.Logger, error) {
	var minimum slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		minimum = slog.LevelDebug
	case "info":
		minimum = slog.LevelInfo
	case "warn":
		minimum = slog.LevelWarn
	case "error":
		minimum = slog.LevelError
	default:
		return nil, fmt.Errorf("unsupported log level %q", level)
	}
	return slog.New(slog.NewTextHandler(output, &slog.HandlerOptions{Level: minimum})), nil
}
