package simulator

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	state := <-updates
	if state.DisplayID != "left" || state.Sequence != 1 {
		t.Fatalf("update = %#v", state)
	}
	if err := backend.Present(context.Background(), "left", solidFrame(color.RGBA{R: 30, A: 255})); err != nil {
		t.Fatal(err)
	}
	state, ok := backend.Snapshot("left")
	if !ok || state.Sequence != 2 {
		t.Fatalf("Snapshot(left) = %#v, %t", state, ok)
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
