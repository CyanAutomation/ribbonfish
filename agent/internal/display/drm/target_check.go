package drm

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

// ValidateTargets checks that every configured display maps to an available
// device node and a connected connector that advertises the requested size.
// It reads only the connector data returned by Discover; it does not open DRM,
// acquire DRM master, or change a display mode.
func ValidateTargets(devicePath string, targets []DisplayTarget, connectors []Connector) error {
	unavailable, err := ValidateTargetsAllowDisconnected(devicePath, targets, connectors)
	if err != nil {
		return err
	}
	if len(unavailable) > 0 {
		return fmt.Errorf("DRM connector %q for display %q is disconnected", unavailable[0].Connector, unavailable[0].ID)
	}
	return nil
}

// ValidateTargetsAllowDisconnected validates the configured device mapping
// and mode requests while returning disconnected connectors for callers that
// can continue without those displays.
func ValidateTargetsAllowDisconnected(devicePath string, targets []DisplayTarget, connectors []Connector) ([]DisplayTarget, error) {
	devicePath = filepath.Clean(strings.TrimSpace(devicePath))
	if devicePath == "." {
		return nil, fmt.Errorf("DRM device path is required")
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("at least one DRM display target is required")
	}

	seenConnectors := make(map[string]struct{}, len(targets))
	var unavailable []DisplayTarget
	for _, target := range targets {
		id := strings.TrimSpace(target.ID)
		name := strings.TrimSpace(target.Connector)
		if id == "" || name == "" {
			return nil, fmt.Errorf("DRM display ID and connector are required")
		}
		if _, exists := seenConnectors[name]; exists {
			return nil, fmt.Errorf("DRM connector %q is assigned more than once", name)
		}
		seenConnectors[name] = struct{}{}

		var found *Connector
		for i := range connectors {
			if connectors[i].Name == name {
				found = &connectors[i]
				break
			}
		}
		if found == nil {
			return nil, fmt.Errorf("DRM connector %q for display %q not found", name, id)
		}
		sameDevice := filepath.Clean(found.Device) == devicePath
		configuredDeviceNumber, configuredDevicePresent := DeviceNodeNumber(devicePath)
		if !sameDevice && configuredDevicePresent && found.deviceNumber != "" && configuredDeviceNumber == found.deviceNumber {
			sameDevice = true
		}
		if !sameDevice {
			return nil, fmt.Errorf("DRM connector %q belongs to %s, configured device is %s", name, found.Device, devicePath)
		}
		if !found.DeviceNodePresent && !configuredDevicePresent {
			return nil, fmt.Errorf("DRM device node %q is missing for connector %q", devicePath, name)
		}
		requested, err := display.ParseMode(target.Mode)
		if err != nil {
			return nil, fmt.Errorf("display %q mode: %w", id, err)
		}
		if found.Status == "disconnected" {
			unavailable = append(unavailable, DisplayTarget{ID: id, Connector: name, Mode: target.Mode})
			continue
		}
		if found.Status != "connected" {
			return nil, fmt.Errorf("DRM connector %q for display %q is %s", name, id, found.Status)
		}
		if len(found.Modes) == 0 {
			return nil, fmt.Errorf("DRM connector %q advertises no modes", name)
		}
		if requested.Preferred {
			continue
		}
		matched := false
		for _, advertisedName := range found.Modes {
			// DRM mode names suffix interlaced and double-scan modes with i/d.
			advertisedName = strings.TrimSuffix(advertisedName, "i")
			advertisedName = strings.TrimSuffix(advertisedName, "d")
			advertised, parseErr := display.ParseMode(advertisedName)
			if parseErr == nil && advertised.Width == requested.Width && advertised.Height == requested.Height {
				matched = true
				break
			}
		}
		if !matched {
			return nil, fmt.Errorf("DRM connector %q does not advertise resolution %dx%d for display %q", name, requested.Width, requested.Height, id)
		}
	}
	return unavailable, nil
}
