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
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	displaySimulator "github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
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

func TestRunUsesConfiguredSimulatorMode(t *testing.T) {
	dir := t.TempDir()
	writeMainPNG(t, filepath.Join(dir, "asset.png"), color.RGBA{G: 180, A: 255})
	configPath := filepath.Join(dir, "config.json")
	body := `{"version":1,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"backend":"simulator","directory":"frames","fit":"contain"},"playlists":[{"id":"p","assets":[{"path":"asset.png"}]}],"displays":[{"id":"left","playlist_id":"p","mode":"4x2@60","rotation_interval":"1h"}]}`
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
	if err := <-done; err != nil {
		t.Fatalf("run() after cancellation = %v", err)
	}
	file, err := os.Open(filepath.Join(dir, "frames", "left.png"))
	if err != nil {
		t.Fatal(err)
	}
	frame, err := png.Decode(file)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := frame.Bounds(); got != image.Rect(0, 0, 4, 2) {
		t.Fatalf("simulator frame bounds = %v, want configured 4x2 mode", got)
	}
	if logs := output.String(); !strings.Contains(logs, `display_backend=simulator`) {
		t.Fatalf("startup log does not identify selected backend: %s", logs)
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

func TestDefaultConfigPathUsesEnvironmentOverride(t *testing.T) {
	t.Setenv("RIBBONFISH_CONFIG_FILE", "/etc/ribbonfish/config.json")
	if got := defaultConfigPath(); got != "/etc/ribbonfish/config.json" {
		t.Fatalf("defaultConfigPath() = %q", got)
	}
}

func TestExampleConfigsLoadAndValidate(t *testing.T) {
	t.Setenv("RIBBONFISH_CACHE_DIR", "")
	t.Setenv("RIBBONFISH_DRM_DEVICE", "")
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller() could not locate test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "../../.."))
	tests := []struct {
		path           string
		backend        string
		displayCount   int
		firstConnector string
		device         string
		firstMode      string
	}{
		{path: "examples/agent/simulator/config.json", backend: "simulator", displayCount: 2},
		{path: "examples/raspberry-pi/simulator-config.json", backend: "simulator", displayCount: 2},
		{path: "examples/raspberry-pi/simulator-config.pi3a-plus.json", backend: "simulator", displayCount: 1, firstConnector: "HDMI-A-1", firstMode: "1920x1080@60"},
		{path: "examples/raspberry-pi/hardware-config.pi3a-plus.json", backend: "drm", displayCount: 1, firstConnector: "HDMI-A-1", device: "/dev/dri/card0", firstMode: "preferred"},
		{path: "examples/raspberry-pi/hardware-config.pi3b.json", backend: "drm", displayCount: 1, firstConnector: "HDMI-A-1"},
		{path: "examples/raspberry-pi/hardware-config.pi4.json", backend: "drm", displayCount: 2, firstConnector: "HDMI-A-1"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			cfg, err := config.Load(filepath.Join(repoRoot, tt.path))
			if err != nil {
				t.Fatalf("config.Load() = %v", err)
			}
			if got := cfg.Output.EffectiveBackend(); got != tt.backend {
				t.Errorf("backend = %q, want %q", got, tt.backend)
			}
			if got := len(cfg.Displays); got != tt.displayCount {
				t.Errorf("display count = %d, want %d", got, tt.displayCount)
			}
			if tt.firstConnector != "" && cfg.Displays[0].Connector != tt.firstConnector {
				t.Errorf("first connector = %q, want %q", cfg.Displays[0].Connector, tt.firstConnector)
			}
			if tt.device != "" && cfg.Output.Device != tt.device {
				t.Errorf("DRM device = %q, want %q", cfg.Output.Device, tt.device)
			}
			if tt.firstMode != "" && cfg.Displays[0].Mode != tt.firstMode {
				t.Errorf("first mode = %q, want %q", cfg.Displays[0].Mode, tt.firstMode)
			}
		})
	}
}

func TestPi3APlusSimulatorUsesObservedHDMIMode(t *testing.T) {
	t.Setenv("RIBBONFISH_CACHE_DIR", "")
	t.Setenv("RIBBONFISH_DRM_DEVICE", "")
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller() could not locate test source")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(source), "../../.."))
	configPath := filepath.Join(repoRoot, "examples/raspberry-pi/simulator-config.pi3a-plus.json")
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() = %v", err)
	}
	cfg.Output.Directory = t.TempDir()
	output, err := newDisplayOutput(cfg)
	if err != nil {
		t.Fatalf("newDisplayOutput() = %v", err)
	}
	defer output.Close()

	frame := image.NewRGBA(image.Rect(0, 0, 2, 1))
	frame.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	frame.SetRGBA(1, 0, color.RGBA{B: 255, A: 255})
	if err := output.Present(context.Background(), "display-main", frame); err != nil {
		t.Fatalf("Present() = %v", err)
	}
	snapshot, ok := output.(*displaySimulator.Simulator).Snapshot("display-main")
	if !ok {
		t.Fatal("Pi 3 A+ display snapshot is missing")
	}
	if got, want := snapshot.Frame.Bounds(), image.Rect(0, 0, 1920, 1080); got != want {
		t.Fatalf("simulator frame bounds = %v, want observed HDMI mode %v", got, want)
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
		Name              string   `json:"name"`
		Device            string   `json:"device"`
		DeviceNodePresent bool     `json:"device_node_present"`
		Driver            string   `json:"driver"`
		Status            string   `json:"status"`
		Modes             []string `json:"modes"`
	}
	if err := json.Unmarshal(output.Bytes(), &got); err != nil {
		t.Fatalf("decode listDRMDisplays() JSON: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("listDRMDisplays() returned %d connectors, want 1: %#v", len(got), got)
	}
	want := struct {
		Name              string   `json:"name"`
		Device            string   `json:"device"`
		DeviceNodePresent bool     `json:"device_node_present"`
		Driver            string   `json:"driver"`
		Status            string   `json:"status"`
		Modes             []string `json:"modes"`
	}{Name: "HDMI-A-1", Device: "/dev/dri/card1", DeviceNodePresent: false, Driver: "vc4-drm", Status: "disconnected", Modes: []string{"1920x1080", "1280x720"}}
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
