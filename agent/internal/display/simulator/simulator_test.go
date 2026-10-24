package simulator

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Test suite contract source: docs/agent-foundation.md#architecture.

func TestSimulatorWritesIndependentAtomicFrames(t *testing.T) {
	dir := t.TempDir()
	backend, err := NewSimulator(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	left := solidFrame(color.RGBA{R: 220, A: 255})
	right := solidFrame(color.RGBA{B: 200, A: 255})
	if err := backend.Present(context.Background(), "display-left", left); err != nil {
		t.Fatal(err)
	}
	if err := backend.Present(context.Background(), "display-right", right); err != nil {
		t.Fatal(err)
	}

	for id, want := range map[string]color.RGBA{"display-left": {R: 220, A: 255}, "display-right": {B: 200, A: 255}} {
		state, ok := backend.Snapshot(id)
		if !ok {
			t.Fatalf("Snapshot(%q) is missing", id)
		}
		if state.Sequence != 1 || state.Path != filepath.Join(dir, id+".png") {
			t.Errorf("Snapshot(%q) = %#v", id, state)
		}
		file, err := os.Open(state.Path)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := png.Decode(file)
		_ = file.Close()
		if err != nil {
			t.Fatalf("decode %s: %v", state.Path, err)
		}
		if got := color.RGBAModel.Convert(decoded.At(0, 0)).(color.RGBA); got != want {
			t.Errorf("%s pixel = %#v, want %#v", id, got, want)
		}
	}

	before, _ := backend.Snapshot("display-left")
	if err := backend.Present(context.Background(), "display-left", nil); err == nil {
		t.Fatal("Present() accepted a nil frame")
	}
	after, _ := backend.Snapshot("display-left")
	if before.Sequence != after.Sequence || before.Path != after.Path {
		t.Errorf("failed replacement changed display state: before=%#v after=%#v", before, after)
	}
	if _, err := os.Stat(before.Path); err != nil {
		t.Errorf("last good PNG was lost after failed replacement: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".ribbonfish-frame-") {
			t.Errorf("temporary frame remains after presentation: %s", entry.Name())
		}
	}
}

func TestSimulatorPublishesObservableStateAndUpdates(t *testing.T) {
	backend, err := NewSimulator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	updates := backend.Updates()
	if err := backend.Present(context.Background(), "left", solidFrame(color.RGBA{G: 80, A: 255})); err != nil {
		t.Fatal(err)
	}
	first := receiveUpdate(t, updates)
	if first.DisplayID != "left" || first.Sequence != 1 {
		t.Fatalf("first update = %#v", first)
	}
	if got := color.RGBAModel.Convert(first.Frame.At(first.Frame.Bounds().Min.X, first.Frame.Bounds().Min.Y)).(color.RGBA); got != (color.RGBA{G: 80, A: 255}) {
		t.Fatalf("first update pixel = %#v", got)
	}
	if err := backend.Present(context.Background(), "left", solidFrame(color.RGBA{R: 30, A: 255})); err != nil {
		t.Fatal(err)
	}
	second := receiveUpdate(t, updates)
	if second.DisplayID != "left" || second.Sequence != 2 {
		t.Fatalf("second update = %#v", second)
	}
	if got := color.RGBAModel.Convert(second.Frame.At(second.Frame.Bounds().Min.X, second.Frame.Bounds().Min.Y)).(color.RGBA); got != (color.RGBA{R: 30, A: 255}) {
		t.Fatalf("second update pixel = %#v", got)
	}
	state, ok := backend.Snapshot("left")
	if !ok || state.Sequence != 2 {
		t.Fatalf("Snapshot(left) = %#v, %t", state, ok)
	}
}

func receiveUpdate(t *testing.T, updates <-chan Snapshot) Snapshot {
	t.Helper()
	select {
	case state, ok := <-updates:
		if !ok {
			t.Fatal("updates channel closed before publishing the expected frame")
		}
		return state
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for display update")
		return Snapshot{}
	}
}

func TestSimulatorKeepsSnapshotsAndOtherDisplaysResponsiveDuringFrameIO(t *testing.T) {
	backend, err := NewSimulator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	frame := &blockingImage{entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(frame.release) })
	presentDone := make(chan error, 1)
	go func() { presentDone <- backend.Present(context.Background(), "display-left", frame) }()
	select {
	case <-frame.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("PNG encoding did not reach the blocking pixel")
	}

	type snapshotResult struct {
		state Snapshot
		ok    bool
	}
	snapshotDone := make(chan snapshotResult, 1)
	go func() {
		state, ok := backend.Snapshot("display-left")
		snapshotDone <- snapshotResult{state: state, ok: ok}
	}()
	select {
	case got := <-snapshotDone:
		if got.ok {
			t.Fatalf("Snapshot() = %#v, true before first frame was published", got.state)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Snapshot() blocked during PNG encoding")
	}

	otherDone := make(chan error, 1)
	go func() {
		otherDone <- backend.Present(context.Background(), "display-right", solidFrame(color.RGBA{B: 90, A: 255}))
	}()
	select {
	case err := <-otherDone:
		if err != nil {
			t.Fatalf("Present(display-right) error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("independent display write blocked behind PNG encoding")
	}

	releaseOnce.Do(func() { close(frame.release) })
	if err := <-presentDone; err != nil {
		t.Fatalf("Present(display-left) error = %v", err)
	}
	if _, ok := backend.Snapshot("display-left"); !ok {
		t.Fatal("Snapshot(display-left) is missing after Present completed")
	}
}

func TestSimulatorRejectsUnsafeDisplayIDs(t *testing.T) {
	backend, err := NewSimulator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	for _, id := range []string{"../escape", "", ".", "display/one"} {
		if err := backend.Present(context.Background(), id, solidFrame(color.RGBA{A: 255})); err == nil {
			t.Errorf("Present(%q) error = nil", id)
		}
	}
}

func solidFrame(value color.RGBA) *image.RGBA {
	frame := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for y := 0; y < frame.Bounds().Dy(); y++ {
		for x := 0; x < frame.Bounds().Dx(); x++ {
			frame.SetRGBA(x, y, value)
		}
	}
	return frame
}

type blockingImage struct {
	entered    chan struct{}
	release    chan struct{}
	enteredOne sync.Once
}

func (*blockingImage) ColorModel() color.Model { return color.RGBAModel }

func (*blockingImage) Bounds() image.Rectangle { return image.Rect(0, 0, 1, 1) }

func (frame *blockingImage) At(_, _ int) color.Color {
	frame.enteredOne.Do(func() { close(frame.entered) })
	<-frame.release
	return color.RGBA{R: 1, A: 255}
}
