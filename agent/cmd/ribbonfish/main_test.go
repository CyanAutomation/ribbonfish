package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Test suite contract sources: agent/README.md and README.md#device-software.

func TestRunSkipsStartupWhenContextIsAlreadyCanceled(t *testing.T) {
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

func TestRunStopsActivePlaybackOnCancellation(t *testing.T) {
	dir := t.TempDir()
	writeMainPNG(t, filepath.Join(dir, "asset.png"), color.RGBA{G: 180, A: 255})
	configPath := filepath.Join(dir, "config.json")
	body := `{"version":1,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"directory":"frames"},"playlists":[{"id":"p","assets":[{"path":"asset.png"}]}],"displays":[{"id":"left","playlist_id":"p","rotation_interval":"1h"}]}`
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &frameLogWriter{frameUpdated: make(chan struct{}, 1)}
	done := make(chan error, 1)
	go func() { done <- run(ctx, configPath, output) }()

	select {
	case <-output.frameUpdated:
	case <-time.After(2 * time.Second):
		t.Fatal("agent did not present its initial frame")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() after cancellation = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not stop after cancellation")
	}
	if logs := output.String(); !strings.Contains(logs, "agent configuration loaded") ||
		!strings.Contains(logs, "display frame updated") || !strings.Contains(logs, "agent shutdown complete") {
		t.Fatalf("missing lifecycle records after active cancellation: %s", logs)
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

func TestListDRMDisplaysReportsConnectorOwningDevice(t *testing.T) {
	sysfsRoot := t.TempDir()
	cardDevice := filepath.Join(sysfsRoot, "card1", "device")
	if err := os.MkdirAll(cardDevice, 0o755); err != nil {
		t.Fatal(err)
	}
	driver := filepath.Join(sysfsRoot, "drivers", "vc4-drm")
	if err := os.MkdirAll(driver, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driver, filepath.Join(cardDevice, "driver")); err != nil {
		t.Fatal(err)
	}
	connector := filepath.Join(sysfsRoot, "card1-HDMI-A-1")
	if err := os.MkdirAll(connector, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "status"), []byte("disconnected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "modes"), []byte("1920x1080\n1280x720\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := listDRMDisplays(sysfsRoot, "/dev/dri", &output); err != nil {
		t.Fatalf("listDRMDisplays() error = %v", err)
	}
	var got []struct {
		Name   string   `json:"name"`
		Device string   `json:"device"`
		Driver string   `json:"driver"`
		Status string   `json:"status"`
		Modes  []string `json:"modes"`
	}
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatalf("decode listDRMDisplays() JSON: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("listDRMDisplays() returned %d connectors, want 1: %#v", len(got), got)
	}
	want := struct {
		Name   string   `json:"name"`
		Device string   `json:"device"`
		Driver string   `json:"driver"`
		Status string   `json:"status"`
		Modes  []string `json:"modes"`
	}{Name: "HDMI-A-1", Device: "/dev/dri/card1", Driver: "vc4-drm", Status: "disconnected", Modes: []string{"1920x1080", "1280x720"}}
	if !reflect.DeepEqual(got[0], want) {
		t.Fatalf("listDRMDisplays() connector = %#v, want %#v", got[0], want)
	}
}

func writeMainPNG(t *testing.T, path string, value color.RGBA) {
	t.Helper()
	frame := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			frame.SetRGBA(x, y, value)
		}
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(file, frame); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

type frameLogWriter struct {
	mu           sync.Mutex
	buffer       bytes.Buffer
	frameUpdated chan struct{}
}

func (w *frameLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	n, err := w.buffer.Write(p)
	w.mu.Unlock()
	if bytes.Contains(p, []byte("display frame updated")) {
		select {
		case w.frameUpdated <- struct{}{}:
		default:
		}
	}
	return n, err
}

func (w *frameLogWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buffer.String()
}
