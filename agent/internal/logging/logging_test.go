package logging

import (
	"bytes"
	"strings"
	"testing"
)

// Test suite contract source: docs/agent-foundation.md#local-configuration-contract.

func TestNewFiltersBelowConfiguredLevel(t *testing.T) {
	var output bytes.Buffer
	logger, err := New(&output, "warn")
	if err != nil {
		t.Fatal(err)
	}
	logger.Info("hidden")
	logger.Warn("visible", "display_id", "left")
	if strings.Contains(output.String(), "hidden") || !strings.Contains(output.String(), "visible") ||
		!strings.Contains(output.String(), "level=WARN") || !strings.Contains(output.String(), "display_id=left") {
		t.Fatalf("unexpected structured log output: %q", output.String())
	}
}

func TestNewRejectsUnknownLevel(t *testing.T) {
	if _, err := New(&bytes.Buffer{}, "trace"); err == nil {
		t.Fatal("New() error = nil, want unsupported level error")
	}
}
