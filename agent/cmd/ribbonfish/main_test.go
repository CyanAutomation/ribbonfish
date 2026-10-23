package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunLoadsConfigAndStopsOnCancellation(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	body := `{"version":1,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"directory":"frames"},"playlists":[{"id":"p","assets":[{"path":"missing.png"}]}],"displays":[{"id":"left","playlist_id":"p","rotation_interval":"1s"}]}`
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if err := run(ctx, configPath, &output); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if !strings.Contains(output.String(), "agent configuration loaded") || !strings.Contains(output.String(), "agent shutdown complete") {
		t.Fatalf("missing lifecycle log records: %s", output.String())
	}
}

func TestRunRejectsInvalidConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), configPath, &bytes.Buffer{}); err == nil {
		t.Fatal("run() error = nil, want config validation error")
	}
}
