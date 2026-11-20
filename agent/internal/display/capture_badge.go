package display

import (
	"image"
	"image/color"
	"image/draw"
	"time"
)

var captureBadgeGlyphs = map[rune][7]uint8{
	'A': {14, 17, 17, 31, 17, 17, 17}, 'B': {30, 17, 17, 30, 17, 17, 30},
	'C': {14, 17, 16, 16, 16, 17, 14}, 'D': {30, 17, 17, 17, 17, 17, 30},
	'E': {31, 16, 16, 30, 16, 16, 31}, 'F': {31, 16, 16, 30, 16, 16, 16},
	'G': {14, 17, 16, 23, 17, 17, 15}, 'H': {17, 17, 17, 31, 17, 17, 17},
	'I': {14, 4, 4, 4, 4, 4, 14}, 'J': {7, 2, 2, 2, 2, 18, 12},
	'K': {17, 18, 20, 24, 20, 18, 17}, 'L': {16, 16, 16, 16, 16, 16, 31},
	'M': {17, 27, 21, 21, 17, 17, 17}, 'N': {17, 25, 21, 19, 17, 17, 17},
	'O': {14, 17, 17, 17, 17, 17, 14}, 'P': {30, 17, 17, 30, 16, 16, 16},
	'Q': {14, 17, 17, 17, 21, 18, 13}, 'R': {30, 17, 17, 30, 20, 18, 17},
	'S': {15, 16, 16, 14, 1, 1, 30}, 'T': {31, 4, 4, 4, 4, 4, 4},
	'U': {17, 17, 17, 17, 17, 17, 14}, 'V': {17, 17, 17, 17, 17, 10, 4},
	'W': {17, 17, 17, 21, 21, 21, 10}, 'X': {17, 17, 10, 4, 10, 17, 17},
	'Y': {17, 17, 10, 4, 4, 4, 4}, 'Z': {31, 1, 2, 4, 8, 16, 31},
	'0': {14, 17, 19, 21, 25, 17, 14}, '1': {4, 12, 4, 4, 4, 4, 14},
	'2': {14, 17, 1, 2, 4, 8, 31}, '3': {30, 1, 1, 14, 1, 1, 30},
	'4': {2, 6, 10, 18, 31, 2, 2}, '5': {31, 16, 16, 30, 1, 1, 30},
	'6': {14, 16, 16, 30, 17, 17, 14}, '7': {31, 1, 2, 4, 8, 8, 8},
	'8': {14, 17, 17, 14, 17, 17, 14}, '9': {14, 17, 17, 15, 1, 1, 14},
	':': {0, 4, 4, 0, 4, 4, 0}, '-': {0, 0, 0, 31, 0, 0, 0},
}

// CaptureTimestampBadgeLines formats an unambiguous UTC time for display.
func CaptureTimestampBadgeLines(capturedAt time.Time) [2]string {
	stamp := capturedAt.UTC()
	return [2]string{"CAPTURED AT " + stamp.Format("15:04") + " UTC", stamp.Format("2006-01-02")}
}

// DrawCaptureTimestampBadge creates a display frame with its capture time
// composited at the upper-right corner. It never modifies the source image.
func DrawCaptureTimestampBadge(source image.Image, capturedAt time.Time) *image.RGBA {
	if source == nil {
		return nil
	}
	bounds := source.Bounds()
	frame := image.NewRGBA(bounds)
	if !bounds.Empty() {
		draw.Draw(frame, bounds, source, bounds.Min, draw.Src)
	}
	if bounds.Empty() || capturedAt.IsZero() {
		return frame
	}
	lines := CaptureTimestampBadgeLines(capturedAt)
	scale := min(4, min(bounds.Dx()/320, bounds.Dy()/180))
	if scale < 1 {
		scale = 1
	}
	padding := 4 * scale
	lineGap := 2 * scale
	textWidth := max(captureTextWidth(lines[0], scale), captureTextWidth(lines[1], scale))
	boxWidth := textWidth + 2*padding
	boxHeight := 14*scale + lineGap + 2*padding
	margin := 4 * scale
	badge := image.NewRGBA(image.Rect(0, 0, boxWidth, boxHeight))
	draw.Draw(badge, badge.Bounds(), image.NewUniform(color.RGBA{R: 12, G: 20, B: 28, A: 232}), image.Point{}, draw.Src)
	lineY := [2]int{padding, padding + 7*scale + lineGap}
	for index, line := range lines {
		lineX := padding + textWidth - captureTextWidth(line, scale)
		drawCaptureBadgeText(badge, image.Pt(lineX, lineY[index]), line, scale)
	}
	badge = halfSizeCaptureBadge(badge)

	margin = (margin + 1) / 2
	if badge.Bounds().Dx()+2*margin > bounds.Dx() || badge.Bounds().Dy()+2*margin > bounds.Dy() {
		return frame
	}

	badgeBounds := image.Rect(bounds.Max.X-margin-badge.Bounds().Dx(), bounds.Min.Y+margin,
		bounds.Max.X-margin, bounds.Min.Y+margin+badge.Bounds().Dy())
	draw.Draw(frame, badgeBounds, badge, badge.Bounds().Min, draw.Over)
	return frame
}

func halfSizeCaptureBadge(source *image.RGBA) *image.RGBA {
	bounds := source.Bounds()
	width := (bounds.Dx() + 1) / 2
	height := (bounds.Dy() + 1) / 2
	resized := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			var red, green, blue, alpha, samples uint32
			for sourceY := y * 2; sourceY < min(y*2+2, bounds.Dy()); sourceY++ {
				for sourceX := x * 2; sourceX < min(x*2+2, bounds.Dx()); sourceX++ {
					pixel := source.RGBAAt(bounds.Min.X+sourceX, bounds.Min.Y+sourceY)
					red += uint32(pixel.R)
					green += uint32(pixel.G)
					blue += uint32(pixel.B)
					alpha += uint32(pixel.A)
					samples++
				}
			}
			resized.SetRGBA(x, y, color.RGBA{
				R: uint8((red + samples/2) / samples),
				G: uint8((green + samples/2) / samples),
				B: uint8((blue + samples/2) / samples),
				A: uint8((alpha + samples/2) / samples),
			})
		}
	}
	return resized
}

func captureTextWidth(value string, scale int) int {
	if len(value) == 0 {
		return 0
	}
	return (len(value)*6 - 1) * scale
}

func drawCaptureBadgeText(frame *image.RGBA, origin image.Point, value string, scale int) {
	for index, character := range value {
		if character == ' ' {
			continue
		}
		rows, ok := captureBadgeGlyphs[character]
		if !ok {
			continue
		}
		glyphOrigin := image.Pt(origin.X+index*6*scale, origin.Y)
		for y, row := range rows {
			for x := 0; x < 5; x++ {
				if row&(1<<uint(4-x)) == 0 {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						frame.SetRGBA(glyphOrigin.X+x*scale+dx, glyphOrigin.Y+y*scale+dy, color.RGBA{R: 255, G: 255, B: 255, A: 255})
					}
				}
			}
		}
	}
}
