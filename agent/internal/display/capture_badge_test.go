package display

import (
	"image"
	"image/color"
	"testing"
	"time"
)

func TestDrawCaptureTimestampBadgeUsesHalfCurrentSize(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetRGBA(x, y, color.RGBA{R: 80, G: 120, B: 160, A: 255})
		}
	}

	frame := DrawCaptureTimestampBadge(source, time.Date(2026, time.November, 19, 14, 32, 0, 0, time.UTC))
	var changed image.Rectangle
	for y := frame.Bounds().Min.Y; y < frame.Bounds().Max.Y; y++ {
		for x := frame.Bounds().Min.X; x < frame.Bounds().Max.X; x++ {
			if frame.RGBAAt(x, y) == source.RGBAAt(x, y) {
				continue
			}
			if changed.Empty() {
				changed = image.Rect(x, y, x+1, y+1)
				continue
			}
			if x < changed.Min.X {
				changed.Min.X = x
			}
			if y < changed.Min.Y {
				changed.Min.Y = y
			}
			if x+1 > changed.Max.X {
				changed.Max.X = x + 1
			}
			if y+1 > changed.Max.Y {
				changed.Max.Y = y + 1
			}
		}
	}

	if got, want := changed, image.Rect(503, 4, 636, 28); got != want {
		t.Fatalf("badge bounds = %v, want half-size bounds %v", got, want)
	}
}

func TestDrawCaptureTimestampBadgeRightAlignsBothTextLines(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetRGBA(x, y, color.RGBA{R: 80, G: 120, B: 160, A: 255})
		}
	}

	frame := DrawCaptureTimestampBadge(source, time.Date(2026, time.November, 19, 14, 32, 0, 0, time.UTC))
	titleRight := lastWhitePixelX(frame, 8, 15)
	dateRight := lastWhitePixelX(frame, 17, 24)
	if want := frame.Bounds().Max.X - 4 - 4 - 1; titleRight != want || dateRight != want {
		t.Fatalf("rightmost text pixels = title %d, date %d; want both at %d", titleRight, dateRight, want)
	}
}

func lastWhitePixelX(frame *image.RGBA, minY, maxY int) int {
	last := -1
	for y := minY; y < maxY; y++ {
		for x := frame.Bounds().Min.X; x < frame.Bounds().Max.X; x++ {
			if frame.RGBAAt(x, y) == (color.RGBA{R: 255, G: 255, B: 255, A: 255}) && x > last {
				last = x
			}
		}
	}
	return last
}
