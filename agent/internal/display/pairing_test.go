package display

import (
	"context"
	"image"
	"image/color"
	"testing"
)

func TestPairingOutputShowsFingerprintUntilCleared(t *testing.T) {
	backend := &pairingTestOutput{}
	state := NewPairingState("ribbonfish-01", "1234-5678-90ab-cdef-1234-5678-90ab-cdef")
	output := NewPairingOutput(backend, state)
	frame := image.NewRGBA(image.Rect(0, 0, 320, 240))
	for y := 0; y < 240; y++ {
		for x := 0; x < 320; x++ {
			frame.SetRGBA(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	if err := output.Present(context.Background(), "main", frame); err != nil {
		t.Fatal(err)
	}
	if backend.lastFrame.Bounds() != frame.Bounds() {
		t.Fatalf("pairing frame bounds = %v, want %v", backend.lastFrame.Bounds(), frame.Bounds())
	}
	if got := backend.lastFrame.RGBAAt(0, 0); got.R == 255 && got.G == 0 && got.B == 0 {
		t.Fatal("pairing screen was not shown in place of the playlist frame")
	}
	brightPixels := 0
	for _, value := range backend.lastFrame.Pix {
		if value > 220 {
			brightPixels++
		}
	}
	if brightPixels < 100 {
		t.Fatalf("pairing screen has too few lit pixels: %d", brightPixels)
	}

	state.Clear()
	if err := output.Present(context.Background(), "main", frame); err != nil {
		t.Fatal(err)
	}
	want := color.RGBA{R: 255, A: 255}
	if got := backend.lastFrame.RGBAAt(0, 0); got != want {
		t.Fatalf("frame after approval = %#v, want original playlist frame", got)
	}
}

type pairingTestOutput struct{ lastFrame *image.RGBA }

func (output *pairingTestOutput) Present(_ context.Context, _ string, frame image.Image) error {
	output.lastFrame = image.NewRGBA(frame.Bounds())
	for y := frame.Bounds().Min.Y; y < frame.Bounds().Max.Y; y++ {
		for x := frame.Bounds().Min.X; x < frame.Bounds().Max.X; x++ {
			output.lastFrame.Set(x, y, frame.At(x, y))
		}
	}
	return nil
}

func (*pairingTestOutput) Close() error { return nil }
