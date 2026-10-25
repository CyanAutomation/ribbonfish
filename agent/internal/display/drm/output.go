package drm

import (
	"context"
	"errors"
	"fmt"
	"image"
	"strings"
	"sync"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

// DisplayTarget maps a stable logical display ID to one DRM connector.
type DisplayTarget struct {
	ID        string
	Connector string
	Mode      string
}

type scanoutSurface interface {
	Present(context.Context, image.Image) error
	Close() error
}

type outputDevice interface {
	Connectors() ([]ConnectorInfo, error)
	OpenSurface(ConnectorInfo, ModeInfo, display.FitMode) (scanoutSurface, error)
	Close() error
}

// Output presents independent logical displays through DRM/KMS connectors.
type Output struct {
	mu       sync.RWMutex
	device   outputDevice
	surfaces map[string]scanoutSurface
	closed   bool
}

var _ display.Output = (*Output)(nil)

// NewOutput opens one DRM card and configures the requested connector map.
func NewOutput(devicePath string, targets []DisplayTarget, fit display.FitMode) (*Output, error) {
	device, err := openKMSDevice(devicePath)
	if err != nil {
		return nil, err
	}
	return newOutputWithDevice(device, targets, fit)
}

func newOutputWithDevice(device outputDevice, targets []DisplayTarget, fit display.FitMode) (*Output, error) {
	if device == nil {
		return nil, errors.New("DRM device is required")
	}
	if len(targets) == 0 {
		_ = device.Close()
		return nil, errors.New("at least one DRM display target is required")
	}
	if fit == "" {
		fit = display.FitContain
	}
	if fit != display.FitContain && fit != display.FitCover && fit != display.FitStretch {
		_ = device.Close()
		return nil, fmt.Errorf("unsupported DRM image fit mode %q", fit)
	}

	connectors, err := device.Connectors()
	if err != nil {
		_ = device.Close()
		return nil, fmt.Errorf("enumerate DRM connectors: %w", err)
	}
	output := &Output{device: device, surfaces: make(map[string]scanoutSurface, len(targets))}
	seenIDs := make(map[string]struct{}, len(targets))
	seenConnectors := make(map[string]struct{}, len(targets))
	cleanup := func(cause error) (*Output, error) {
		return nil, errors.Join(cause, output.Close())
	}
	for _, target := range targets {
		id := strings.TrimSpace(target.ID)
		connectorName := strings.TrimSpace(target.Connector)
		if id == "" || connectorName == "" {
			return cleanup(errors.New("DRM display ID and connector are required"))
		}
		if _, exists := seenIDs[id]; exists {
			return cleanup(fmt.Errorf("DRM display ID %q is assigned more than once", id))
		}
		if _, exists := seenConnectors[connectorName]; exists {
			return cleanup(fmt.Errorf("DRM connector %q is assigned more than once", connectorName))
		}
		seenIDs[id] = struct{}{}
		seenConnectors[connectorName] = struct{}{}
		request, err := display.ParseMode(target.Mode)
		if err != nil {
			return cleanup(fmt.Errorf("display %q mode: %w", id, err))
		}
		connector, mode, err := SelectConnectorMode(connectors, connectorName, request)
		if err != nil {
			return cleanup(err)
		}
		if mode.Width == 0 || mode.Height == 0 || uint64(mode.Width) > display.MaxOutputPixels/uint64(mode.Height) {
			return cleanup(fmt.Errorf("DRM connector %q mode %s exceeds the supported %d-pixel framebuffer limit", connectorName, mode.Name, display.MaxOutputPixels))
		}
		surface, err := device.OpenSurface(connector, mode, fit)
		if err != nil {
			return cleanup(fmt.Errorf("configure display %q on %s: %w", id, connectorName, err))
		}
		if surface == nil {
			return cleanup(fmt.Errorf("configure display %q on %s: device returned no scanout surface", id, connectorName))
		}
		output.surfaces[id] = surface
	}
	return output, nil
}

// Present writes a frame to the configured connector for displayID.
func (output *Output) Present(ctx context.Context, displayID string, frame image.Image) error {
	output.mu.RLock()
	defer output.mu.RUnlock()
	if output.closed {
		return errors.New("DRM output is closed")
	}
	surface, ok := output.surfaces[displayID]
	if !ok {
		return fmt.Errorf("unknown DRM display %q", displayID)
	}
	return surface.Present(ctx, frame)
}

// Close disables its scanout surfaces, releases DRM master, and closes the card.
func (output *Output) Close() error {
	output.mu.Lock()
	defer output.mu.Unlock()
	if output.closed {
		return nil
	}
	output.closed = true
	var failures []error
	for id, surface := range output.surfaces {
		if err := surface.Close(); err != nil {
			failures = append(failures, fmt.Errorf("close display %q: %w", id, err))
		}
	}
	if err := output.device.Close(); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}
