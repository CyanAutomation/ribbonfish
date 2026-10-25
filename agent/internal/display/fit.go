package display

import (
	"errors"
	"image"
	"image/color"
	"math"
	"strings"
)

// FitMode controls how an input image is placed into a display mode.
type FitMode string

const (
	FitContain FitMode = "contain"
	FitCover   FitMode = "cover"
	FitStretch FitMode = "stretch"
)

// MaxOutputPixels limits decoded output surfaces to 64 MiB each in RGBA.
// DRM uses two scanout surfaces, keeping its framebuffer allocation bounded.
const MaxOutputPixels = uint64(16 * 1024 * 1024)

// FitImage resamples source into an opaque, mode-sized image. Contain preserves
// the full image with black bars, cover fills the mode and crops overflow, and
// stretch fills the mode without preserving aspect ratio.
func FitImage(source image.Image, width, height int, mode FitMode) (*image.RGBA, error) {
	if source == nil {
		return nil, errors.New("source image is required")
	}
	if width <= 0 || height <= 0 || uint64(width) > MaxOutputPixels/uint64(height) {
		return nil, errors.New("output dimensions must be positive and no larger than 16 megapixels")
	}
	if source.Bounds().Empty() {
		return nil, errors.New("source image dimensions must be greater than zero")
	}
	mode = FitMode(strings.ToLower(strings.TrimSpace(string(mode))))
	if mode == "" {
		mode = FitContain
	}
	if mode != FitContain && mode != FitCover && mode != FitStretch {
		return nil, errors.New("fit mode must be contain, cover, or stretch")
	}

	result := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 3; i < len(result.Pix); i += 4 {
		result.Pix[i] = 0xff
	}
	if mode == FitStretch {
		drawRegion(result, source, source.Bounds(), image.Rect(0, 0, width, height))
		return result, nil
	}

	sourceBounds := source.Bounds()
	sourceWidth, sourceHeight := float64(sourceBounds.Dx()), float64(sourceBounds.Dy())
	targetAspect := float64(width) / float64(height)
	sourceAspect := sourceWidth / sourceHeight
	if mode == FitContain {
		scale := math.Min(float64(width)/sourceWidth, float64(height)/sourceHeight)
		drawWidth := max(1, int(math.Round(sourceWidth*scale)))
		drawHeight := max(1, int(math.Round(sourceHeight*scale)))
		dest := image.Rect((width-drawWidth)/2, (height-drawHeight)/2, (width-drawWidth)/2+drawWidth, (height-drawHeight)/2+drawHeight)
		drawRegion(result, source, sourceBounds, dest)
		return result, nil
	}

	// Cover crops the source symmetrically to the target aspect before scaling.
	crop := sourceBounds
	if sourceAspect > targetAspect {
		cropWidth := int(math.Round(sourceHeight * targetAspect))
		cropWidth = min(sourceBounds.Dx(), max(1, cropWidth))
		crop.Min.X += (sourceBounds.Dx() - cropWidth) / 2
		crop.Max.X = crop.Min.X + cropWidth
	} else if sourceAspect < targetAspect {
		cropHeight := int(math.Round(sourceWidth / targetAspect))
		cropHeight = min(sourceBounds.Dy(), max(1, cropHeight))
		crop.Min.Y += (sourceBounds.Dy() - cropHeight) / 2
		crop.Max.Y = crop.Min.Y + cropHeight
	}
	drawRegion(result, source, crop, image.Rect(0, 0, width, height))
	return result, nil
}

func drawRegion(dst *image.RGBA, source image.Image, sourceRect, destRect image.Rectangle) {
	scaleX := float64(sourceRect.Dx()) / float64(destRect.Dx())
	scaleY := float64(sourceRect.Dy()) / float64(destRect.Dy())
	for y := destRect.Min.Y; y < destRect.Max.Y; y++ {
		for x := destRect.Min.X; x < destRect.Max.X; x++ {
			sx := float64(sourceRect.Min.X) + (float64(x-destRect.Min.X)+0.5)*scaleX - 0.5
			sy := float64(sourceRect.Min.Y) + (float64(y-destRect.Min.Y)+0.5)*scaleY - 0.5
			if sx < float64(sourceRect.Min.X) || sx > float64(sourceRect.Max.X-1) || sy < float64(sourceRect.Min.Y) || sy > float64(sourceRect.Max.Y-1) {
				sx = clamp(sx, float64(sourceRect.Min.X), float64(sourceRect.Max.X-1))
				sy = clamp(sy, float64(sourceRect.Min.Y), float64(sourceRect.Max.Y-1))
			}
			dst.SetRGBA(x, y, bilinear(source, sx, sy))
		}
	}
}

func bilinear(source image.Image, x, y float64) color.RGBA {
	bounds := source.Bounds()
	x = clamp(x, float64(bounds.Min.X), float64(bounds.Max.X-1))
	y = clamp(y, float64(bounds.Min.Y), float64(bounds.Max.Y-1))
	x0, y0 := int(math.Floor(x)), int(math.Floor(y))
	x1, y1 := min(x0+1, bounds.Max.X-1), min(y0+1, bounds.Max.Y-1)
	fx, fy := x-float64(x0), y-float64(y0)
	c00, c10 := rgba64(source.At(x0, y0)), rgba64(source.At(x1, y0))
	c01, c11 := rgba64(source.At(x0, y1)), rgba64(source.At(x1, y1))
	var channels [4]uint8
	for i := range channels {
		top := float64(c00[i])*(1-fx) + float64(c10[i])*fx
		bottom := float64(c01[i])*(1-fx) + float64(c11[i])*fx
		channels[i] = uint8(math.Round(top*(1-fy) + bottom*fy))
	}
	return color.RGBA{R: channels[0], G: channels[1], B: channels[2], A: channels[3]}
}

func rgba64(value color.Color) [4]uint8 {
	r, g, b, a := value.RGBA()
	return [4]uint8{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

func clamp(value, low, high float64) float64 {
	return math.Max(low, math.Min(value, high))
}
