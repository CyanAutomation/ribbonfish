package display

import (
	"context"
	"image"
	"image/color"
	"strings"
	"sync"
)

// PairingState controls the temporary enrollment message shown on device displays.
type PairingState struct {
	mu          sync.RWMutex
	status      string
	deviceID    string
	fingerprint string
}

// NewPairingState creates a pairing display in the pending state.
func NewPairingState(deviceID, fingerprint string) *PairingState {
	return &PairingState{status: "pending", deviceID: deviceID, fingerprint: fingerprint}
}

// SetStatus updates the visible enrollment state. An empty status clears it.
func (state *PairingState) SetStatus(status string) {
	state.mu.Lock()
	state.status = strings.ToLower(strings.TrimSpace(status))
	state.mu.Unlock()
}

// Clear removes the pairing message after successful approval.
func (state *PairingState) Clear() { state.SetStatus("") }

func (state *PairingState) snapshot() (string, string, string) {
	state.mu.RLock()
	defer state.mu.RUnlock()
	return state.status, state.deviceID, state.fingerprint
}

// PairingOutput temporarily replaces playlist frames with an approval card.
type PairingOutput struct {
	backend Output
	state   *PairingState
}

// NewPairingOutput wraps a display backend with the device approval card.
func NewPairingOutput(backend Output, state *PairingState) *PairingOutput {
	return &PairingOutput{backend: backend, state: state}
}

func (output *PairingOutput) Present(ctx context.Context, displayID string, frame image.Image) error {
	status, deviceID, fingerprint := output.state.snapshot()
	if status == "" {
		return output.backend.Present(ctx, displayID, frame)
	}
	return output.backend.Present(ctx, displayID, RenderPairingCard(frame.Bounds(), status, deviceID, fingerprint))
}

func (output *PairingOutput) Close() error { return output.backend.Close() }

// DisplayAvailable preserves backend availability information through the
// pairing overlay.
func (output *PairingOutput) DisplayAvailable(displayID string) bool {
	availability, ok := output.backend.(Availability)
	return !ok || availability.DisplayAvailable(displayID)
}

// RenderPairingCard creates a self-contained bitmap so the agent can show a
// device identity without adding a font or graphics dependency.
func RenderPairingCard(bounds image.Rectangle, status, deviceID, fingerprint string) *image.RGBA {
	card := image.NewRGBA(bounds)
	background := color.RGBA{R: 16, G: 42, B: 67, A: 255}
	panel := color.RGBA{R: 26, G: 61, B: 91, A: 255}
	ink := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	accent := color.RGBA{R: 85, G: 220, B: 168, A: 255}
	fill(card, bounds, background)
	status = strings.ToLower(strings.TrimSpace(status))
	lines := []string{"WAITING FOR APPROVAL"}
	if status == "rejected" {
		lines = []string{"REQUEST REJECTED", "ASK ADMIN TO REVIEW"}
	} else if status == "disabled" {
		lines = []string{"DEVICE DISABLED", "ASK ADMIN TO ENABLE"}
	}
	columns := max(1, (bounds.Dx()-24)/6)
	var wrapped []string
	for _, line := range lines {
		wrapped = append(wrapped, wrapPairingText(line, columns)...)
	}
	wrapped = append(wrapped, "DEVICE ID")
	wrapped = append(wrapped, wrapPairingText(strings.ToUpper(deviceID), columns)...)
	wrapped = append(wrapped, "COMPARE THIS CODE")
	groups := strings.Split(strings.ToUpper(fingerprint), "-")
	groupLimit := min(4, max(1, columns/5))
	for start := 0; start < len(groups); start += groupLimit {
		end := min(start+groupLimit, len(groups))
		wrapped = append(wrapped, strings.Join(groups[start:end], "-"))
	}
	if len(wrapped) == 0 {
		wrapped = []string{"WAITING FOR APPROVAL"}
	}

	maxColumns := 0
	for _, line := range wrapped {
		maxColumns = max(maxColumns, len([]rune(line)))
	}
	contentWidth := max(1, maxColumns*6-1)
	contentHeight := len(wrapped)*9 - 2
	availableWidth := max(1, bounds.Dx()-24)
	availableHeight := max(1, bounds.Dy()-24)
	scale := min(availableWidth/contentWidth, availableHeight/contentHeight)
	if scale < 1 {
		scale = 1
	}
	textWidth := contentWidth * scale
	textHeight := contentHeight * scale
	left := bounds.Min.X + (bounds.Dx()-textWidth)/2
	top := bounds.Min.Y + (bounds.Dy()-textHeight)/2
	panelBounds := image.Rect(
		max(bounds.Min.X, left-12),
		max(bounds.Min.Y, top-10),
		min(bounds.Max.X, left+textWidth+12),
		min(bounds.Max.Y, top+textHeight+10),
	)
	fill(card, panelBounds, panel)
	for index, line := range wrapped {
		color := ink
		if index >= len(lines)+1+len(wrapPairingText(strings.ToUpper(deviceID), columns)) {
			color = accent
		}
		drawPairingText(card, left, top+index*9*scale, line, scale, color)
	}
	return card
}

func fill(target *image.RGBA, bounds image.Rectangle, value color.RGBA) {
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			target.SetRGBA(x, y, value)
		}
	}
}

func wrapPairingText(value string, width int) []string {
	characters := []rune(value)
	if len(characters) == 0 {
		return []string{""}
	}
	var lines []string
	for len(characters) > 0 {
		count := min(width, len(characters))
		lines = append(lines, string(characters[:count]))
		characters = characters[count:]
	}
	return lines
}

func drawPairingText(target *image.RGBA, x, y int, value string, scale int, ink color.RGBA) {
	for _, character := range strings.ToUpper(value) {
		glyph, ok := pairingGlyphs[character]
		if !ok {
			glyph = pairingGlyphs['?']
		}
		for row, pixels := range glyph {
			for column, pixel := range pixels {
				if pixel != '1' {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						px, py := x+column*scale+dx, y+row*scale+dy
						if image.Pt(px, py).In(target.Bounds()) {
							target.SetRGBA(px, py, ink)
						}
					}
				}
			}
		}
		x += 6 * scale
	}
}

var pairingGlyphs = map[rune][7]string{
	'0': {"01110", "10001", "10011", "10101", "11001", "10001", "01110"},
	'1': {"00100", "01100", "00100", "00100", "00100", "00100", "01110"},
	'2': {"01110", "10001", "00001", "00010", "00100", "01000", "11111"},
	'3': {"11110", "00001", "00001", "01110", "00001", "00001", "11110"},
	'4': {"00010", "00110", "01010", "10010", "11111", "00010", "00010"},
	'5': {"11111", "10000", "10000", "11110", "00001", "00001", "11110"},
	'6': {"01110", "10000", "10000", "11110", "10001", "10001", "01110"},
	'7': {"11111", "00001", "00010", "00100", "01000", "01000", "01000"},
	'8': {"01110", "10001", "10001", "01110", "10001", "10001", "01110"},
	'9': {"01110", "10001", "10001", "01111", "00001", "00001", "01110"},
	'A': {"01110", "10001", "10001", "11111", "10001", "10001", "10001"},
	'B': {"11110", "10001", "10001", "11110", "10001", "10001", "11110"},
	'C': {"01111", "10000", "10000", "10000", "10000", "10000", "01111"},
	'D': {"11110", "10001", "10001", "10001", "10001", "10001", "11110"},
	'E': {"11111", "10000", "10000", "11110", "10000", "10000", "11111"},
	'F': {"11111", "10000", "10000", "11110", "10000", "10000", "10000"},
	'G': {"01111", "10000", "10000", "10111", "10001", "10001", "01111"},
	'H': {"10001", "10001", "10001", "11111", "10001", "10001", "10001"},
	'I': {"01110", "00100", "00100", "00100", "00100", "00100", "01110"},
	'J': {"00111", "00010", "00010", "00010", "00010", "10010", "01100"},
	'K': {"10001", "10010", "10100", "11000", "10100", "10010", "10001"},
	'L': {"10000", "10000", "10000", "10000", "10000", "10000", "11111"},
	'M': {"10001", "11011", "10101", "10101", "10001", "10001", "10001"},
	'N': {"10001", "11001", "10101", "10011", "10001", "10001", "10001"},
	'O': {"01110", "10001", "10001", "10001", "10001", "10001", "01110"},
	'P': {"11110", "10001", "10001", "11110", "10000", "10000", "10000"},
	'Q': {"01110", "10001", "10001", "10001", "10101", "10010", "01101"},
	'R': {"11110", "10001", "10001", "11110", "10100", "10010", "10001"},
	'S': {"01111", "10000", "10000", "01110", "00001", "00001", "11110"},
	'T': {"11111", "00100", "00100", "00100", "00100", "00100", "00100"},
	'U': {"10001", "10001", "10001", "10001", "10001", "10001", "01110"},
	'V': {"10001", "10001", "10001", "10001", "10001", "01010", "00100"},
	'W': {"10001", "10001", "10001", "10101", "10101", "10101", "01010"},
	'X': {"10001", "10001", "01010", "00100", "01010", "10001", "10001"},
	'Y': {"10001", "10001", "01010", "00100", "00100", "00100", "00100"},
	'Z': {"11111", "00001", "00010", "00100", "01000", "10000", "11111"},
	'-': {"00000", "00000", "00000", "11111", "00000", "00000", "00000"},
	'_': {"00000", "00000", "00000", "00000", "00000", "00000", "11111"},
	'.': {"00000", "00000", "00000", "00000", "00000", "00110", "00110"},
	':': {"00000", "00110", "00110", "00000", "00110", "00110", "00000"},
	' ': {"00000", "00000", "00000", "00000", "00000", "00000", "00000"},
	'?': {"01110", "10001", "00001", "00010", "00100", "00000", "00100"},
}
