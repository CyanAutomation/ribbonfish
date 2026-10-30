package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/agent"
	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/drm"
	displaySimulator "github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/health"
	"github.com/CyanAutomation/ribbonfish/agent/internal/syncer"
)

// Test suite contract sources: agent/README.md and README.md#device-software.

func TestRunLogsShutdownWithoutOpeningRuntimeResourcesForCanceledContext(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	body := `{"version":2,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"directory":"frames"},"playlist":{"id":"p","rotation_interval":"1s","assets":[{"path":"missing.png"}]},"displays":[{"id":"left"}]}`
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
	for _, path := range []string{filepath.Join(dir, "cache"), filepath.Join(dir, "frames")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("runtime resource %q was opened for an already-canceled run; stat error = %v", path, err)
		}
	}
}

func TestRunStopsActivePlaybackOnCancellation(t *testing.T) {
	dir := t.TempDir()
	writeMainPNG(t, filepath.Join(dir, "asset.png"), color.RGBA{G: 180, A: 255})
	configPath := filepath.Join(dir, "config.json")
	body := `{"version":2,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"directory":"frames"},"playlist":{"id":"p","rotation_interval":"1h","assets":[{"path":"asset.png"}]},"displays":[{"id":"left"}]}`
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
	body := `{"version":2,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"backend":"simulator","directory":"frames","fit":"contain"},"playlist":{"id":"p","rotation_interval":"1h","assets":[{"path":"asset.png"}]},"displays":[{"id":"left","mode":"4x2@60"}]}`
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
}

func TestRunRejectsInvalidConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), configPath, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "version must be 2") {
		t.Fatalf("run() error = %v, want version validation diagnostic", err)
	}
}

func TestDefaultConfigPathUsesEnvironmentOverride(t *testing.T) {
	t.Setenv("RIBBONFISH_CONFIG_FILE", "/etc/ribbonfish/config.json")
	if got := defaultConfigPath(); got != "/etc/ribbonfish/config.json" {
		t.Fatalf("defaultConfigPath() = %q", got)
	}
}

func TestDefaultConfigPathSelectsBundledProfile(t *testing.T) {
	t.Setenv("RIBBONFISH_CONFIG_FILE", "")
	t.Setenv("RIBBONFISH_DEFAULTS_DIR", "/usr/share/ribbonfish/defaults")
	t.Setenv("RIBBONFISH_PROFILE", "pi3a-plus")
	if got := defaultConfigPath(); got != "/usr/share/ribbonfish/defaults/pi3a-plus.json" {
		t.Fatalf("defaultConfigPath() = %q", got)
	}
	t.Setenv("RIBBONFISH_PROFILE", "../../tmp/evil")
	if got := defaultConfigPath(); got != "/usr/share/ribbonfish/defaults/pi4.json" {
		t.Fatalf("invalid profile path = %q, want safe Pi 4 fallback", got)
	}
}

func TestDefaultConfigPathSelectsPi3APlusSimulatorProfile(t *testing.T) {
	t.Setenv("RIBBONFISH_CONFIG_FILE", "")
	t.Setenv("RIBBONFISH_DEFAULTS_DIR", "/usr/share/ribbonfish/defaults")
	t.Setenv("RIBBONFISH_PROFILE", "simulator-pi3a-plus")
	if got, want := defaultConfigPath(), "/usr/share/ribbonfish/defaults/simulator-pi3a-plus.json"; got != want {
		t.Fatalf("defaultConfigPath() = %q, want %q", got, want)
	}
}

func TestCheckDRMDisplaysMatchesConnectedConfiguredConnector(t *testing.T) {
	t.Setenv("RIBBONFISH_CACHE_DIR", "")
	t.Setenv("RIBBONFISH_DRM_DEVICE", "")
	dir := t.TempDir()
	devRoot := filepath.Join(dir, "dev", "dri")
	if err := os.MkdirAll(devRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	devicePath := filepath.Join(devRoot, "card0")
	if err := os.Symlink(os.DevNull, devicePath); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	configBody := `{"version":2,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"backend":"drm","device":"DEVICE_PATH","fit":"contain"},"playlist":{"id":"default","rotation_interval":"15s","assets":[{"path":"asset.png"}]},"displays":[{"id":"display-main","connector":"HDMI-A-1","mode":"1920x1080@60"}]}`
	configBody = strings.Replace(configBody, "DEVICE_PATH", devicePath, 1)
	if err := os.WriteFile(configPath, []byte(configBody), 0o600); err != nil {
		t.Fatal(err)
	}

	sysfsRoot := filepath.Join(dir, "sysfs", "drm")
	cardDevice := filepath.Join(sysfsRoot, "card0", "device")
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
	connector := filepath.Join(sysfsRoot, "card0-HDMI-A-1")
	if err := os.MkdirAll(connector, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "status"), []byte("connected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "modes"), []byte("1920x1080\n1280x720\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := checkDRMDisplays(configPath, sysfsRoot, devRoot, &output); err != nil {
		t.Fatalf("checkDRMDisplays() error = %v", err)
	}
	if !strings.Contains(output.String(), "connector=HDMI-A-1") || !strings.Contains(output.String(), "device="+devicePath) {
		t.Fatalf("checkDRMDisplays() output = %q, want connected device and connector summary", output.String())
	}

	if err := os.WriteFile(filepath.Join(connector, "status"), []byte("disconnected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := checkDRMDisplays(configPath, sysfsRoot, devRoot, &output); err != nil {
		t.Fatalf("checkDRMDisplays() error = %v, want disconnected connector warning", err)
	}
	if !strings.Contains(output.String(), "warning") || !strings.Contains(output.String(), "status=disconnected") {
		t.Fatalf("checkDRMDisplays() output = %q, want a warning and disconnected status", output.String())
	}
}

func TestReportUnavailableDisplaysWarnsAndMarksHealthDegraded(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	tracker := health.NewTracker("test", t.TempDir(), []health.OutputSpec{{DisplayID: "display-right", Connector: "HDMI-A-2"}}, time.Now)
	tracker.SetState("ready")
	output := &diagnosticDisplayOutput{unavailable: []drm.DisplayTarget{{ID: "display-right", Connector: "HDMI-A-2"}}}

	reportUnavailableDisplays(output, tracker, logger)

	if !strings.Contains(logs.String(), "connector is disconnected") || !strings.Contains(logs.String(), "HDMI-A-2") {
		t.Fatalf("startup logs = %q, want disconnected connector warning", logs.String())
	}
	report := tracker.Snapshot(time.Now())
	if report.State != "degraded" || len(report.Outputs) != 1 || report.Outputs[0].Status != "failed" ||
		report.Outputs[0].ErrorCode == nil || *report.Outputs[0].ErrorCode != "connector_disconnected" {
		t.Fatalf("health report = %#v, want degraded state and connector_disconnected", report)
	}
}

type diagnosticDisplayOutput struct{ unavailable []drm.DisplayTarget }

func (*diagnosticDisplayOutput) Present(context.Context, string, image.Image) error { return nil }
func (*diagnosticDisplayOutput) Close() error                                       { return nil }
func (output *diagnosticDisplayOutput) UnavailableDisplays() []drm.DisplayTarget {
	return output.unavailable
}

func TestCheckDRMDisplaysAcceptsStableByPathAlias(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("DRM device identity matching is Linux-specific")
	}
	deviceNumber, ok := drm.DeviceNodeNumber(os.DevNull)
	if !ok {
		t.Skip("Linux /dev/null character-device number is unavailable")
	}
	t.Setenv("RIBBONFISH_CACHE_DIR", "")
	t.Setenv("RIBBONFISH_DRM_DEVICE", "")
	dir := t.TempDir()
	devRoot := filepath.Join(dir, "dev", "dri")
	aliasDir := filepath.Join(devRoot, "by-path")
	if err := os.MkdirAll(aliasDir, 0o755); err != nil {
		t.Fatal(err)
	}
	devicePath := filepath.Join(aliasDir, "platform-gpu-card")
	if err := os.Symlink(os.DevNull, devicePath); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	configBody := `{"version":2,"log_level":"info","cache":{"directory":"cache","max_bytes":1024},"output":{"backend":"drm","device":"DEVICE_PATH","fit":"contain"},"playlist":{"id":"default","rotation_interval":"15s","assets":[{"path":"asset.png"}]},"displays":[{"id":"display-main","connector":"HDMI-A-1","mode":"preferred"}]}`
	configBody = strings.Replace(configBody, "DEVICE_PATH", devicePath, 1)
	if err := os.WriteFile(configPath, []byte(configBody), 0o600); err != nil {
		t.Fatal(err)
	}

	sysfsRoot := filepath.Join(dir, "sysfs", "drm")
	cardDevice := filepath.Join(sysfsRoot, "card0", "device")
	if err := os.MkdirAll(cardDevice, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sysfsRoot, "card0", "dev"), []byte(deviceNumber+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	driver := filepath.Join(sysfsRoot, "drivers", "vc4-drm")
	if err := os.MkdirAll(driver, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driver, filepath.Join(cardDevice, "driver")); err != nil {
		t.Fatal(err)
	}
	connector := filepath.Join(sysfsRoot, "card0-HDMI-A-1")
	if err := os.MkdirAll(connector, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "status"), []byte("connected\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connector, "modes"), []byte("1920x1080\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := checkDRMDisplays(configPath, sysfsRoot, devRoot, &output); err != nil {
		t.Fatalf("checkDRMDisplays() rejected the stable device alias: %v", err)
	}
	if !strings.Contains(output.String(), "device="+devicePath) {
		t.Fatalf("checkDRMDisplays() output = %q, want configured device alias", output.String())
	}
}

func TestRunSyncLoopPersistsAndActivatesVerifiedContent(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "old.png")
	newPath := filepath.Join(dir, "new.png")
	writeMainPNG(t, oldPath, color.RGBA{R: 170, A: 255})
	writeMainPNG(t, newPath, color.RGBA{G: 190, A: 255})
	cfg := config.Config{
		Version:  2,
		LogLevel: "info",
		Cache:    config.CacheConfig{Directory: filepath.Join(dir, "cache"), MaxBytes: 1 << 20},
		Output:   config.OutputConfig{Backend: "simulator", Directory: filepath.Join(dir, "frames"), Fit: "contain"},
		Playlist: config.PlaylistConfig{ID: "welcome", RotationInterval: "1h", Assets: []config.AssetConfig{{Path: oldPath}}},
		Displays: []config.DisplayConfig{{ID: "screen-main", Mode: "4x4"}},
	}
	store, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	output, err := newDisplayOutput(cfg)
	if err != nil {
		t.Fatal(err)
	}
	playback, err := agent.New(context.Background(), cfg, store, output, slog.New(slog.NewTextHandler(io.Discard, nil)), agent.RealClock{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan error, 1)
	go func() { runDone <- playback.Run(ctx) }()
	waitForPNGColor(t, filepath.Join(cfg.Output.Directory, "screen-main.png"), color.RGBA{R: 170, A: 255})

	newBytes, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatal(err)
	}
	asset, err := store.Put(ctx, bytes.NewReader(newBytes), "")
	if err != nil {
		t.Fatal(err)
	}
	digestBytes := sha256.Sum256(newBytes)
	if asset.SHA256 != hex.EncodeToString(digestBytes[:]) {
		t.Fatalf("cache digest = %q, want calculated digest", asset.SHA256)
	}
	candidate := cfg
	candidate.Playlist = config.PlaylistConfig{ID: "welcome", RotationInterval: "1h", Assets: []config.AssetConfig{{Path: asset.Path, SHA256: asset.SHA256}}}
	snapshot := syncer.PlaylistSnapshot{
		Version:          2,
		Revision:         "remote-3",
		ID:               "welcome",
		RotationInterval: "1h",
		Assets:           []syncer.PlaylistAsset{{SHA256: asset.SHA256, Size: asset.Bytes}},
	}
	snapshotPath := filepath.Join(cfg.Cache.Directory, "last-good.json")
	remote := &oneShotSynchronizer{update: syncer.Update{Config: candidate, Snapshot: snapshot, ETag: `"remote-3"`, Changed: true}}
	syncDone := make(chan error, 1)
	go func() {
		syncDone <- runSyncLoop(ctx, remote, cfg, playback, snapshotPath, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()

	deadline := time.After(3 * time.Second)
	for playback.CurrentConfig().Playlist.Assets[0].SHA256 != asset.SHA256 {
		select {
		case <-deadline:
			t.Fatal("remote content was not activated")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if _, err := os.Stat(snapshotPath); err != nil {
		t.Fatalf("last-good snapshot was not persisted: %v", err)
	}
	waitForPNGColor(t, filepath.Join(cfg.Output.Directory, "screen-main.png"), color.RGBA{G: 190, A: 255})

	cancel()
	if err := <-runDone; err != nil {
		t.Fatalf("playback Run() = %v", err)
	}
	if err := <-syncDone; err != nil {
		t.Fatalf("sync loop = %v", err)
	}
}

func TestRunSyncLoopLogsSuccessfulUnchangedPollsAndRecovery(t *testing.T) {
	t.Setenv("RIBBONFISH_SYNC_INTERVAL", "1ms")
	tests := []struct {
		name  string
		steps []syncResult
		warns int
	}{
		{
			name: "logs first unchanged poll once",
			steps: []syncResult{
				{update: syncer.Update{ETag: `"revision-current"`}},
				{update: syncer.Update{ETag: `"revision-current"`}},
			},
		},
		{
			name: "logs success after a sync failure",
			steps: []syncResult{
				{err: errors.New("network unavailable")},
				{update: syncer.Update{ETag: `"revision-current"`}},
			},
			warns: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			remote := &scriptedSynchronizer{steps: tt.steps, cancel: cancel, cancelOnCall: len(tt.steps)}
			var logs bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&logs, nil))

			if err := runSyncLoop(ctx, remote, config.Config{}, syncLoopTestPlayback{}, "", nil, nil, logger); err != nil {
				t.Fatalf("runSyncLoop() error = %v", err)
			}
			if got := strings.Count(logs.String(), `msg="remote synchronization succeeded"`); got != 1 {
				t.Fatalf("successful sync log count = %d, want 1; logs: %s", got, logs.String())
			}
			if !strings.Contains(logs.String(), "revision-current") {
				t.Fatalf("successful sync log omitted current revision; logs: %s", logs.String())
			}
			if !strings.Contains(logs.String(), "changed=false") {
				t.Fatalf("successful unchanged sync log omitted its unchanged status; logs: %s", logs.String())
			}
			if got := strings.Count(logs.String(), `msg="remote synchronization failed; keeping last good content"`); got != tt.warns {
				t.Fatalf("sync failure log count = %d, want %d; logs: %s", got, tt.warns, logs.String())
			}
			if got := remote.callCount(); got != len(tt.steps) {
				t.Fatalf("Synchronize() call count = %d, want %d", got, len(tt.steps))
			}
		})
	}
}

func TestDeviceEnrollmentWaitsForApprovalThenStartsSignedSync(t *testing.T) {
	t.Setenv("RIBBONFISH_SYNC_INTERVAL", "1ms")
	key, err := syncer.LoadOrCreateDeviceKey(filepath.Join(t.TempDir(), "device-key"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := cache.NewFileStore(filepath.Join(t.TempDir(), "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	gotEnrollment := make(chan struct{}, 1)
	gotSignedSync := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/enrollment-requests":
			gotEnrollment <- struct{}{}
			var body struct {
				DeviceID  string `json:"device_id"`
				PublicKey string `json:"public_key"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode automatic enrollment request: %v", err)
			}
			if body.DeviceID != "pi-office" || body.PublicKey != key.PublicKeyText() || r.Header.Get("X-Ribbonfish-Signature") == "" {
				t.Errorf("automatic enrollment request identity or proof is missing: %#v", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"approved","fingerprint":"` + key.Fingerprint() + `","request_id":"` + key.RequestID() + `","expires_at":null,"replaces_existing":false}`))
		case "/v2/playlist":
			if r.Header.Get("X-Ribbonfish-Device-ID") != "pi-office" ||
				r.Header.Get("X-Ribbonfish-Signature") == "" || r.Header.Get("Authorization") != "" {
				t.Error("approved sync request did not use the key-based identity")
			}
			gotSignedSync <- struct{}{}
			cancel()
			w.WriteHeader(http.StatusNotModified)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	pairing := display.NewPairingState("pi-office", key.Fingerprint())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err = runDeviceEnrollmentLoop(ctx, server.URL, "pi-office", key, store, config.Config{},
		syncLoopTestPlayback{}, "", nil, pairing, nil, nil, logger)
	if err != nil {
		t.Fatalf("runDeviceEnrollmentLoop() error = %v", err)
	}
	select {
	case <-gotEnrollment:
	default:
		t.Fatal("device did not automatically request enrollment")
	}
	select {
	case <-gotSignedSync:
	default:
		t.Fatal("approved device did not start signed playlist synchronization")
	}

	backend := &enrollmentStateOutput{}
	output := display.NewPairingOutput(backend, pairing)
	frame := image.NewRGBA(image.Rect(0, 0, 8, 8))
	frame.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	if err := output.Present(context.Background(), "main", frame); err != nil {
		t.Fatal(err)
	}
	want := color.RGBA{R: 255, A: 255}
	if got := backend.frame.At(0, 0); got != want {
		t.Fatalf("pairing output remains visible after approval: %#v", got)
	}
}

type enrollmentStateOutput struct{ frame image.Image }

func (output *enrollmentStateOutput) Present(_ context.Context, _ string, frame image.Image) error {
	output.frame = frame
	return nil
}

func (*enrollmentStateOutput) Close() error { return nil }

type syncLoopTestPlayback struct{}

func (syncLoopTestPlayback) CurrentConfig() config.Config {
	return config.Config{}
}

func (syncLoopTestPlayback) ApplyConfig(context.Context, config.Config) error {
	return nil
}

type syncResult struct {
	update syncer.Update
	err    error
}

type scriptedSynchronizer struct {
	mu           sync.Mutex
	steps        []syncResult
	calls        int
	cancel       context.CancelFunc
	cancelOnCall int
}

func (s *scriptedSynchronizer) Synchronize(context.Context, config.Config, config.Config) (syncer.Update, error) {
	s.mu.Lock()
	call := s.calls + 1
	s.calls = call
	step := s.steps[min(call-1, len(s.steps)-1)]
	cancel := s.cancel
	shouldCancel := call == s.cancelOnCall
	s.mu.Unlock()
	if shouldCancel {
		cancel()
	}
	return step.update, step.err
}

func (s *scriptedSynchronizer) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

type oneShotSynchronizer struct {
	update syncer.Update
	calls  int
}

func (s *oneShotSynchronizer) Synchronize(context.Context, config.Config, config.Config) (syncer.Update, error) {
	if s.calls == 0 {
		s.calls++
		return s.update, nil
	}
	return syncer.Update{}, nil
}

func waitForPNGColor(t *testing.T, filename string, want color.RGBA) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		file, err := os.Open(filename)
		if err == nil {
			frame, decodeErr := png.Decode(file)
			_ = file.Close()
			if decodeErr == nil {
				got := color.RGBAModel.Convert(frame.At(frame.Bounds().Min.X, frame.Bounds().Min.Y)).(color.RGBA)
				if got == want {
					return
				}
			}
		}
		select {
		case <-deadline:
			t.Fatalf("frame %s did not become color %#v", filename, want)
		case <-time.After(5 * time.Millisecond):
		}
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
		displayIDs     []string
		firstConnector string
		device         string
		firstMode      string
	}{
		{path: "examples/agent/simulator/config.json", backend: "simulator", displayIDs: []string{"display-left", "display-right"}},
		{path: "examples/raspberry-pi/simulator-config.json", backend: "simulator", displayIDs: []string{"display-left", "display-right"}},
		{path: "examples/raspberry-pi/simulator-config.pi3a-plus.json", backend: "simulator", displayIDs: []string{"display-main"}, firstConnector: "HDMI-A-1", firstMode: "1920x1080@60"},
		{path: "examples/raspberry-pi/hardware-config.pi3a-plus.json", backend: "drm", displayIDs: []string{"display-main"}, firstConnector: "HDMI-A-1", device: "/dev/dri/card0", firstMode: "preferred"},
		{path: "examples/raspberry-pi/hardware-config.pi3b.json", backend: "drm", displayIDs: []string{"display-main"}, firstConnector: "HDMI-A-1", device: "/dev/dri/card0", firstMode: "preferred"},
		{path: "examples/raspberry-pi/hardware-config.pi4.json", backend: "drm", displayIDs: []string{"display-left", "display-right"}, firstConnector: "HDMI-A-1", device: "/dev/dri/by-path/platform-gpu-card", firstMode: "preferred"},
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
			gotIDs := make([]string, len(cfg.Displays))
			for i, display := range cfg.Displays {
				gotIDs[i] = display.ID
			}
			if !reflect.DeepEqual(gotIDs, tt.displayIDs) {
				t.Errorf("display IDs = %v, want %v", gotIDs, tt.displayIDs)
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

func TestBundledProfilesLoadWithVerifiedSharedOfflinePlaylist(t *testing.T) {
	t.Setenv("RIBBONFISH_CACHE_DIR", "")
	t.Setenv("RIBBONFISH_DRM_DEVICE", "")
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller() could not locate test source")
	}
	defaults := filepath.Clean(filepath.Join(filepath.Dir(source), "../../defaults"))
	profiles := []string{"pi3a-plus.json", "pi3b.json", "pi4.json", "simulator.json", "simulator-pi3a-plus.json", "simulator-pi3b.json", "simulator-pi4.json"}
	var sharedPlaylist *config.PlaylistConfig
	for _, name := range profiles {
		t.Run(name, func(t *testing.T) {
			cfg, err := config.Load(filepath.Join(defaults, name))
			if err != nil {
				t.Fatalf("config.Load() = %v", err)
			}
			if name == "simulator-pi4.json" {
				wantIDs := []string{"display-left", "display-right"}
				wantConnectors := []string{"HDMI-A-1", "HDMI-A-2"}
				if len(cfg.Displays) != len(wantIDs) {
					t.Fatalf("Pi 4 simulator has %d displays, want %d", len(cfg.Displays), len(wantIDs))
				}
				for i := range wantIDs {
					if got := cfg.Displays[i].ID; got != wantIDs[i] {
						t.Errorf("Pi 4 simulator display %d ID = %q, want %q", i, got, wantIDs[i])
					}
					if got := cfg.Displays[i].Connector; got != wantConnectors[i] {
						t.Errorf("Pi 4 simulator display %d connector = %q, want %q", i, got, wantConnectors[i])
					}
					if got := cfg.Displays[i].Mode; got != "1920x1080@60" {
						t.Errorf("Pi 4 simulator display %d mode = %q, want 1920x1080@60", i, got)
					}
				}
			}
			if name == "pi4.json" && cfg.Output.Device != "/dev/dri/by-path/platform-gpu-card" {
				t.Errorf("Pi 4 default DRM device = %q, want stable KMS alias", cfg.Output.Device)
			}
			if sharedPlaylist == nil {
				playlistCopy := cfg.Playlist
				sharedPlaylist = &playlistCopy
			} else if !reflect.DeepEqual(cfg.Playlist, *sharedPlaylist) {
				t.Errorf("profile playlist differs from the shared offline playlist")
			}
			for _, asset := range cfg.Playlist.Assets {
				data, err := os.ReadFile(asset.Path)
				if err != nil {
					t.Errorf("bundled asset %q is unavailable: %v", asset.Path, err)
					continue
				}
				actual := sha256.Sum256(data)
				if got, want := hex.EncodeToString(actual[:]), asset.SHA256; got != want {
					t.Errorf("asset %q SHA-256 = %q, want %q", asset.Path, got, want)
				}
			}
		})
	}
	if sharedPlaylist == nil || sharedPlaylist.ID != "default" || sharedPlaylist.RotationInterval != "15s" {
		t.Fatalf("bundled playlist = %#v, want id default and 15s rotation", sharedPlaylist)
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
	configPath := filepath.Join(repoRoot, "agent/defaults/simulator-pi3a-plus.json")
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
	devRoot := filepath.Join(t.TempDir(), "dri")
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
	if err := listDRMDisplays(sysfsRoot, devRoot, &output); err != nil {
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
	}{Name: "HDMI-A-1", Device: filepath.Join(devRoot, "card1"), DeviceNodePresent: false, Driver: "vc4-drm", Status: "disconnected", Modes: []string{"1920x1080", "1280x720"}}
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
