// Package display defines hardware-independent output contracts.
package display

import (
	"context"
	"image"
)

// Output presents a decoded frame on one named logical display. A future
// DRM/KMS implementation and the software simulator share this interface.
type Output interface {
	Present(ctx context.Context, displayID string, frame image.Image) error
	Close() error
}
