// Package display defines hardware-independent output contracts.
package display

import (
	"context"
	"image"
	"time"
)

// Output presents a decoded frame on one named logical display. A future
// DRM/KMS implementation and the software simulator share this interface.
type Output interface {
	Present(ctx context.Context, displayID string, frame image.Image) error
	Close() error
}

// TimestampedOutput overlays capture metadata after fitting the image to the
// display mode. Outputs that do not implement it receive an agent-composited
// frame through Output.Present.
type TimestampedOutput interface {
	PresentCaptured(ctx context.Context, displayID string, frame image.Image, capturedAt time.Time) error
}

// Availability is optionally implemented by outputs that can identify
// configured displays that are currently unavailable.
type Availability interface {
	DisplayAvailable(displayID string) bool
}
