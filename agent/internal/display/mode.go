package display

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var modePattern = regexp.MustCompile(`^(\d{1,5})x(\d{1,5})(?:@(\d{1,3}))?$`)

// ModeSpec is either the preferred connector mode or an explicit mode size
// and optional refresh rate.
type ModeSpec struct {
	Width     uint32
	Height    uint32
	Refresh   uint32
	Preferred bool
}

// ParseMode accepts "preferred" or a mode such as "1920x1080@60". An empty
// value is equivalent to "preferred" so existing local configurations remain
// valid.
func ParseMode(value string) (ModeSpec, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "preferred") {
		return ModeSpec{Preferred: true}, nil
	}
	match := modePattern.FindStringSubmatch(value)
	if match == nil {
		return ModeSpec{}, fmt.Errorf("mode must be \"preferred\" or WIDTHxHEIGHT[@REFRESH], got %q", value)
	}
	width, _ := strconv.ParseUint(match[1], 10, 32)
	height, _ := strconv.ParseUint(match[2], 10, 32)
	if width == 0 || height == 0 || width > 16384 || height > 16384 || width > uint64(MaxOutputPixels)/height {
		return ModeSpec{}, fmt.Errorf("mode dimensions must be between 1 and 16384 and no larger than %d pixels, got %q", MaxOutputPixels, value)
	}
	spec := ModeSpec{Width: uint32(width), Height: uint32(height)}
	if match[3] != "" {
		refresh, _ := strconv.ParseUint(match[3], 10, 32)
		if refresh == 0 || refresh > 240 {
			return ModeSpec{}, fmt.Errorf("mode refresh must be between 1 and 240, got %q", value)
		}
		spec.Refresh = uint32(refresh)
	}
	return spec, nil
}
