package display

import (
	"image"
	"image/color"
	"testing"
)

func TestFitImageContainsWithBlackBars(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2, 1))
	source.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	source.SetRGBA(1, 0, color.RGBA{B: 255, A: 255})

	got, err := FitImage(source, 2, 2, FitContain)
	if err != nil {
		t.Fatal(err)
	}
	if got.Bounds() != image.Rect(0, 0, 2, 2) {
		t.Fatalf("bounds = %v", got.Bounds())
	}
	if got.At(0, 1) != (color.RGBA{A: 255}) {
		t.Fatalf("bar pixel = %#v, want opaque black", got.At(0, 1))
	}
	if got.At(0, 0) != (color.RGBA{R: 255, A: 255}) || got.At(1, 0) != (color.RGBA{B: 255, A: 255}) {
		t.Fatalf("content row = %#v, %#v", got.At(0, 0), got.At(1, 0))
	}
}

func TestFitImageStretchAndCoverFillTarget(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2, 1))
	source.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	source.SetRGBA(1, 0, color.RGBA{B: 255, A: 255})

	for _, mode := range []FitMode{FitStretch, FitCover} {
		t.Run(string(mode), func(t *testing.T) {
			got, err := FitImage(source, 3, 3, mode)
			if err != nil {
				t.Fatal(err)
			}
			if got.Bounds() != image.Rect(0, 0, 3, 3) {
				t.Fatalf("bounds = %v", got.Bounds())
			}
			if got.At(1, 1) == (color.RGBA{A: 255}) {
				t.Fatalf("center pixel is black for %s", mode)
			}
		})
	}
}

func TestFitImageRejectsOversizedDimensionsWithoutAllocating(t *testing.T) {
	if _, err := FitImage(image.NewRGBA(image.Rect(0, 0, 1, 1)), int(^uint(0)>>1), 2, FitContain); err == nil {
		t.Fatal("FitImage() accepted dimensions above its pixel budget")
	}
}
