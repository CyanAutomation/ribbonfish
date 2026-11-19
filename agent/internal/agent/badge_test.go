package agent

import (
	"image"
	"image/color"
	"testing"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

func TestCaptureBadgeUsesUTCAndKeepsSourceFrameUntouched(t *testing.T) {
	capturedAt := time.Date(2026, time.November, 19, 14, 32, 0, 0, time.UTC).UnixMilli()
	source := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetRGBA(x, y, color.RGBA{R: 80, G: 120, B: 160, A: 255})
		}
	}

	frame := drawCaptureBadge(source, capturedAt, true)
	if frame == source {
		t.Fatal("drawCaptureBadge returned the source image")
	}
	if got := display.CaptureTimestampBadgeLines(time.UnixMilli(capturedAt)); got != [2]string{"CAPTURED AT 14:32 UTC", "2026-11-19"} {
		t.Fatalf("badge text = %q, want UTC time and date", got)
	}
	corner := image.Pt(frame.Bounds().Max.X-10, frame.Bounds().Min.Y+10)
	if got, want := color.RGBAModel.Convert(frame.At(corner.X, corner.Y)), color.RGBAModel.Convert(source.At(corner.X, corner.Y)); got == want {
		t.Fatalf("badge did not change its background pixel: got %#v", got)
	}
	textPixel := image.Pt(frame.Bounds().Max.X-264, frame.Bounds().Min.Y+16)
	if got, want := color.RGBAModel.Convert(frame.At(textPixel.X, textPixel.Y)), (color.RGBA{R: 255, G: 255, B: 255, A: 255}); got != want {
		t.Fatalf("badge text pixel = %#v, want white glyph", got)
	}
	if got, want := source.At(corner.X, corner.Y), (color.RGBA{R: 80, G: 120, B: 160, A: 255}); got != want {
		t.Fatalf("source frame changed at badge position: got %#v, want %#v", got, want)
	}
}

func TestCaptureBadgeSkipsAssetsWithoutCaptureTime(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 640, 360))
	if got := drawCaptureBadge(source, 0, false); got != source {
		t.Fatal("asset without a capture timestamp received a badge")
	}
}
