package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display/simulator"
	"github.com/CyanAutomation/ribbonfish/agent/internal/playlist"
)

// Test suite contract sources: docs/agent-foundation.md#local-configuration-contract and #cache-behavior.

func TestAgentSharesTheActivePlaylistAndIntervalAcrossDisplays(t *testing.T) {
	dir := t.TempDir()
	leftFirstPath := filepath.Join(dir, "left-first.png")
	leftSecondPath := filepath.Join(dir, "left-second.png")
	leftThirdPath := filepath.Join(dir, "left-third.png")
	leftFirstData := writePNG(t, leftFirstPath, color.RGBA{R: 200, A: 255})
	writePNG(t, leftSecondPath, color.RGBA{G: 150, A: 255})
	writePNG(t, leftThirdPath, color.RGBA{B: 180, A: 255})
	cfg := testConfig(dir, config.PlaylistConfig{ID: "default", RotationInterval: "10s", Assets: []config.AssetConfig{
		{Path: leftFirstPath}, {Path: filepath.Join(dir, "missing.png")}, {Path: leftSecondPath}, {Path: leftThirdPath},
	}})
	cfg.Displays = []config.DisplayConfig{
		{ID: "display-left"},
		{ID: "display-right"},
	}
	store, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	output := &recordingOutput{frames: make(chan frameEvent, 16)}
	clock := newTestClock(time.Unix(0, 0).UTC())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	app, err := New(context.Background(), cfg, store, output, logger, clock)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	// Simulate a cached file becoming corrupt after startup; playback must leave
	// the display usable by choosing the next verified playlist entry.
	firstHash := sha256.Sum256(leftFirstData)
	if err := os.WriteFile(filepath.Join(cfg.Cache.Directory, hex.EncodeToString(firstHash[:])+".img"), []byte("corrupt after startup"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx) }()
	initial := collectFrames(t, output.frames, 2)
	if got := initial["display-left"].pixel; got != (color.RGBA{G: 150, A: 255}) {
		t.Errorf("left initial frame = %#v, want second asset after corrupt first was skipped", got)
	}
	if got := initial["display-right"].pixel; got != initial["display-left"].pixel {
		t.Errorf("right initial frame = %#v, want same shared playlist frame", got)
	}
	waitForTimers(t, clock, 2)

	clock.Advance(3 * time.Second)
	select {
	case event := <-output.frames:
		t.Fatalf("display rotated before the global 10-second interval: %#v", event)
	default:
	}

	clock.Advance(7 * time.Second)
	select {
	case event := <-output.frames:
		t.Fatalf("same playlist asset was needlessly redrawn at 10 seconds: %#v", event)
	default:
	}
	waitForTimers(t, clock, 2)
	clock.Advance(10 * time.Second)
	lateFrames := collectFrames(t, output.frames, 2)
	if got := lateFrames["display-left"].pixel; got != (color.RGBA{B: 180, A: 255}) {
		t.Errorf("left frame at 20 seconds = %#v, want third playlist asset", got)
	}
	if got := lateFrames["display-right"].pixel; got != lateFrames["display-left"].pixel {
		t.Errorf("right frame at 20 seconds = %#v, want same shared playlist frame", got)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run() after cancellation = %v", err)
	}
	_ = store.Close()
}

func TestAgentUsesCachedAssetWhenSourceIsUnavailable(t *testing.T) {
	dir := t.TempDir()
	data := pngData(t, color.RGBA{G: 210, A: 255})
	storeDir := filepath.Join(dir, "cache")
	store, err := cache.NewFileStore(storeDir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	asset, err := store.Put(context.Background(), bytes.NewReader(data), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := cache.NewFileStore(storeDir, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(dir, config.PlaylistConfig{ID: "offline", RotationInterval: "1m", Assets: []config.AssetConfig{{Path: filepath.Join(dir, "missing.png"), SHA256: asset.SHA256}}})
	cfg.Displays = []config.DisplayConfig{{ID: "display-offline"}}
	output := &recordingOutput{frames: make(chan frameEvent, 1)}
	app, err := New(context.Background(), cfg, restarted, output, slog.New(slog.NewTextHandler(io.Discard, nil)), newTestClock(time.Unix(0, 0)))
	if err != nil {
		t.Fatalf("New() failed to use cached image: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx) }()
	frame := receiveFrame(t, output.frames)
	if frame.displayID != "display-offline" || frame.pixel != (color.RGBA{G: 210, A: 255}) {
		t.Fatalf("offline frame = %#v", frame)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run() after cancellation = %v", err)
	}
	_ = restarted.Close()
}

func TestAgentWritesTwoDisplaysThroughSoftwareBackend(t *testing.T) {
	dir := t.TempDir()
	leftPath := filepath.Join(dir, "left.png")
	rightPath := filepath.Join(dir, "right.png")
	writePNG(t, leftPath, color.RGBA{R: 210, A: 255})
	writePNG(t, rightPath, color.RGBA{B: 190, A: 255})
	cfg := testConfig(dir, config.PlaylistConfig{ID: "default", RotationInterval: "5s", Assets: []config.AssetConfig{{Path: leftPath}, {Path: rightPath}}})
	cfg.Displays = []config.DisplayConfig{
		{ID: "display-left"},
		{ID: "display-right"},
	}
	imageCache, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer imageCache.Close()
	backend, err := simulator.NewSimulator(cfg.Output.Directory)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	app, err := New(context.Background(), cfg, imageCache, backend, slog.New(slog.NewTextHandler(io.Discard, nil)), newTestClock(time.Unix(0, 0)))
	if err != nil {
		t.Fatal(err)
	}
	updates := backend.Updates()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx) }()
	seen := make(map[string]color.RGBA)
	for len(seen) < 2 {
		select {
		case state := <-updates:
			pixel := color.RGBAModel.Convert(state.Frame.At(state.Frame.Bounds().Min.X, state.Frame.Bounds().Min.Y)).(color.RGBA)
			if state.Sequence != 1 {
				t.Errorf("first frame sequence for %s = %d, want 1", state.DisplayID, state.Sequence)
			}
			file, err := os.Open(state.Path)
			if err != nil {
				t.Errorf("simulated frame is missing at %s: %v", state.Path, err)
				continue
			}
			decoded, decodeErr := png.Decode(file)
			closeErr := file.Close()
			if decodeErr != nil {
				t.Errorf("decode simulated frame %s: %v", state.Path, decodeErr)
			}
			if closeErr != nil {
				t.Errorf("close simulated frame %s: %v", state.Path, closeErr)
			}
			if decodeErr != nil || closeErr != nil {
				continue
			}
			if got := color.RGBAModel.Convert(decoded.At(decoded.Bounds().Min.X, decoded.Bounds().Min.Y)).(color.RGBA); got != pixel {
				t.Errorf("simulated PNG pixel for %s = %#v, want %#v", state.DisplayID, got, pixel)
				continue
			}
			seen[state.DisplayID] = pixel
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for both simulated display frames")
		}
	}
	if seen["display-left"] != (color.RGBA{R: 210, A: 255}) || seen["display-right"] != (color.RGBA{R: 210, A: 255}) {
		t.Fatalf("simulator states = %#v, want both displays to share first playlist item", seen)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run() after cancellation = %v", err)
	}
}

func TestRunDisplayWaitsUntilNextRotationBoundary(t *testing.T) {
	dir := t.TempDir()
	store, err := cache.NewFileStore(filepath.Join(dir, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	asset, err := store.Put(context.Background(), bytes.NewReader(pngData(t, color.RGBA{R: 40, A: 255})), "")
	if err != nil {
		t.Fatal(err)
	}
	anchor := time.Unix(0, 0).UTC()
	schedule := playlist.Schedule{
		DisplayID: "display",
		Interval:  10 * time.Second,
		Entries:   []playlist.Entry{{SHA256: asset.SHA256, Path: "fixture.png"}},
		Anchor:    anchor,
	}
	engine, err := playlist.New([]playlist.Schedule{schedule})
	if err != nil {
		t.Fatal(err)
	}
	clock := &sequenceClock{
		values: []time.Time{anchor, anchor.Add(9 * time.Second), anchor.Add(11 * time.Second)},
		waits:  make(chan time.Duration, 1),
	}
	output := &recordingOutput{frames: make(chan frameEvent, 1)}
	app := &Agent{
		cache:     store,
		output:    output,
		logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		clock:     clock,
		scheduler: engine,
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		app.runDisplay(ctx, schedule)
		close(done)
	}()
	_ = receiveFrame(t, output.frames)

	select {
	case got := <-clock.waits:
		if got != time.Second {
			t.Errorf("wait until next playlist boundary = %v, want 1s", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("display loop did not schedule its next wait")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("display loop did not stop after cancellation")
	}
}

func TestAgentRunReturnsCleanlyWhenCanceled(t *testing.T) {
	dir := t.TempDir()
	store, err := cache.NewFileStore(filepath.Join(dir, "cache"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	asset, err := store.Put(context.Background(), bytes.NewReader(pngData(t, color.RGBA{G: 40, A: 255})), "")
	if err != nil {
		t.Fatal(err)
	}
	anchor := time.Unix(0, 0).UTC()
	schedule := playlist.Schedule{
		DisplayID: "display",
		Interval:  time.Minute,
		Entries:   []playlist.Entry{{SHA256: asset.SHA256, Path: "fixture.png"}},
		Anchor:    anchor,
	}
	engine, err := playlist.New([]playlist.Schedule{schedule})
	if err != nil {
		t.Fatal(err)
	}
	clock := newTestClock(anchor)
	output := &recordingOutput{frames: make(chan frameEvent, 1)}
	var logs bytes.Buffer
	app := &Agent{
		cache:     store,
		output:    output,
		logger:    slog.New(slog.NewTextHandler(&logs, nil)),
		clock:     clock,
		scheduler: engine,
		displays:  []preparedSchedule{{schedule: schedule}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- app.Run(ctx)
	}()
	_ = receiveFrame(t, output.frames)
	waitForTimers(t, clock, 1)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() after cancellation = %v, want clean shutdown", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not stop after cancellation")
	}
	if strings.Contains(logs.String(), "level=ERROR") {
		t.Errorf("cancellation logged an error: %s", logs.String())
	}
}

func TestApplyConfigSwitchesContentWithoutChangingLocalOutput(t *testing.T) {
	dir := t.TempDir()
	firstPath := filepath.Join(dir, "first.png")
	secondPath := filepath.Join(dir, "second.png")
	writePNG(t, firstPath, color.RGBA{R: 180, A: 255})
	secondData := writePNG(t, secondPath, color.RGBA{G: 190, A: 255})
	cfg := testConfig(dir, config.PlaylistConfig{ID: "welcome", Assets: []config.AssetConfig{{Path: firstPath}}})
	store, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	output := &recordingOutput{frames: make(chan frameEvent, 4)}
	app, err := New(context.Background(), cfg, store, output, slog.New(slog.NewTextHandler(io.Discard, nil)), newTestClock(time.Unix(0, 0)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx) }()
	if got := receiveFrame(t, output.frames).pixel; got != (color.RGBA{R: 180, A: 255}) {
		t.Fatalf("initial frame = %#v", got)
	}

	secondDigest := sha256.Sum256(secondData)
	secondHash := hex.EncodeToString(secondDigest[:])
	if _, err := store.Put(context.Background(), bytes.NewReader(secondData), secondHash); err != nil {
		t.Fatalf("cache candidate content: %v", err)
	}
	candidate := testConfig(dir, config.PlaylistConfig{ID: "welcome", Assets: []config.AssetConfig{{Path: "cached:" + secondHash, SHA256: secondHash}}})
	candidate.Output.Directory = cfg.Output.Directory
	if err := app.ApplyConfig(context.Background(), candidate); err != nil {
		t.Fatalf("ApplyConfig() error = %v", err)
	}
	if got := receiveFrame(t, output.frames).pixel; got != (color.RGBA{G: 190, A: 255}) {
		t.Fatalf("updated frame = %#v, want new content without waiting for rotation", got)
	}

	unsafe := candidate
	unsafe.Output.Directory = filepath.Join(dir, "different-output")
	if err := app.ApplyConfig(context.Background(), unsafe); err == nil {
		t.Fatal("ApplyConfig accepted a remote change to local output settings")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() after cancellation = %v", err)
	}
}

func TestApplyConfigRejectsMissingSnapshotAssets(t *testing.T) {
	dir := t.TempDir()
	starter := filepath.Join(dir, "starter.png")
	writePNG(t, starter, color.RGBA{R: 180, A: 255})
	cfg := testConfig(dir, config.PlaylistConfig{ID: "welcome", Assets: []config.AssetConfig{{Path: starter}}})
	store, err := cache.NewFileStore(cfg.Cache.Directory, cfg.Cache.MaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	app, err := New(context.Background(), cfg, store, &recordingOutput{frames: make(chan frameEvent, 2)}, slog.New(slog.NewTextHandler(io.Discard, nil)), newTestClock(time.Unix(0, 0)))
	if err != nil {
		t.Fatal(err)
	}

	missingDigest := sha256.Sum256(pngData(t, color.RGBA{G: 190, A: 255}))
	digest := hex.EncodeToString(missingDigest[:])
	candidate := testConfig(dir, config.PlaylistConfig{ID: "welcome", Assets: []config.AssetConfig{{Path: "cached:" + digest, SHA256: digest}}})
	candidate.Output.Directory = cfg.Output.Directory
	if err := app.ApplyConfig(context.Background(), candidate); err == nil {
		t.Fatal("ApplyConfig accepted a snapshot with an unavailable image")
	}
	if got := app.CurrentConfig().Playlist.Assets[0].Path; got != starter {
		t.Fatalf("active content changed after failed update: path = %q, want %q", got, starter)
	}
}

func testConfig(dir string, playlist config.PlaylistConfig) config.Config {
	if playlist.RotationInterval == "" {
		playlist.RotationInterval = "1s"
	}
	return config.Config{
		Version:  2,
		LogLevel: "info",
		Cache:    config.CacheConfig{Directory: filepath.Join(dir, "cache"), MaxBytes: 1 << 20},
		Output:   config.OutputConfig{Directory: filepath.Join(dir, "frames")},
		Playlist: playlist,
		Displays: []config.DisplayConfig{{ID: "display"}},
	}
}

func writePNG(t *testing.T, path string, value color.RGBA) []byte {
	t.Helper()
	data := pngData(t, value)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return data
}

func pngData(t *testing.T, value color.RGBA) []byte {
	t.Helper()
	frame := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			frame.SetRGBA(x, y, value)
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, frame); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

type frameEvent struct {
	displayID string
	pixel     color.RGBA
}

type sequenceClock struct {
	values []time.Time
	index  int
	waits  chan time.Duration
}

func (clock *sequenceClock) Now() time.Time {
	index := clock.index
	clock.index++
	if index >= len(clock.values) {
		return clock.values[len(clock.values)-1]
	}
	return clock.values[index]
}

func (clock *sequenceClock) Wait(ctx context.Context, duration time.Duration) error {
	clock.waits <- duration
	<-ctx.Done()
	return ctx.Err()
}

type recordingOutput struct{ frames chan frameEvent }

func (o *recordingOutput) Present(ctx context.Context, displayID string, frame image.Image) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	pixel := color.RGBAModel.Convert(frame.At(frame.Bounds().Min.X, frame.Bounds().Min.Y)).(color.RGBA)
	o.frames <- frameEvent{displayID: displayID, pixel: pixel}
	return nil
}

func (*recordingOutput) Close() error { return nil }

func collectFrames(t *testing.T, frames <-chan frameEvent, count int) map[string]frameEvent {
	t.Helper()
	collected := make(map[string]frameEvent, count)
	for len(collected) < count {
		event := receiveFrame(t, frames)
		collected[event.displayID] = event
	}
	return collected
}

func receiveFrame(t *testing.T, frames <-chan frameEvent) frameEvent {
	t.Helper()
	select {
	case event := <-frames:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for display frame")
		return frameEvent{}
	}
}

func waitForTimers(t *testing.T, clock *testClock, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		select {
		case <-clock.waiting:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for display scheduler timers")
		}
	}
}

type testClock struct {
	mu      sync.Mutex
	now     time.Time
	nextID  int
	waiters map[int]testWaiter
	waiting chan struct{}
}

type testWaiter struct {
	deadline time.Time
	ready    chan struct{}
}

func newTestClock(now time.Time) *testClock {
	return &testClock{now: now, waiters: make(map[int]testWaiter), waiting: make(chan struct{}, 32)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Wait(ctx context.Context, duration time.Duration) error {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	waiter := testWaiter{deadline: c.now.Add(duration), ready: make(chan struct{})}
	c.waiters[id] = waiter
	c.mu.Unlock()
	c.waiting <- struct{}{}
	select {
	case <-waiter.ready:
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.waiters, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

func (c *testClock) Advance(duration time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(duration)
	for id, waiter := range c.waiters {
		if !waiter.deadline.After(c.now) {
			delete(c.waiters, id)
			close(waiter.ready)
		}
	}
	c.mu.Unlock()
}
