package drm

import (
	"errors"
	"fmt"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

// ModeInfo is a KMS mode advertised by a connector.
type ModeInfo struct {
	Name      string
	Width     uint32
	Height    uint32
	Refresh   uint32
	Preferred bool
	kernel    any
}

// ConnectorInfo is a DRM connector and the encoders it can use.
type ConnectorInfo struct {
	Name      string
	ID        uint32
	Connected bool
	Modes     []ModeInfo
	Encoders  []uint32
}

// EncoderInfo describes a connector encoder's compatible CRTCs.
type EncoderInfo struct {
	ID            uint32
	CRTCID        uint32
	PossibleCRTCs uint32
}

// SelectConnectorMode finds a connected named connector and chooses either
// its preferred mode or an explicitly requested resolution and refresh rate.
func SelectConnectorMode(connectors []ConnectorInfo, name string, request display.ModeSpec) (ConnectorInfo, ModeInfo, error) {
	var connector *ConnectorInfo
	for i := range connectors {
		if connectors[i].Name == name {
			connector = &connectors[i]
			break
		}
	}
	if connector == nil {
		return ConnectorInfo{}, ModeInfo{}, fmt.Errorf("DRM connector %q not found", name)
	}
	if !connector.Connected {
		return ConnectorInfo{}, ModeInfo{}, fmt.Errorf("DRM connector %q is disconnected", name)
	}
	if len(connector.Modes) == 0 {
		return ConnectorInfo{}, ModeInfo{}, fmt.Errorf("DRM connector %q advertises no display modes", name)
	}

	if request.Preferred || request.Width == 0 || request.Height == 0 {
		for _, mode := range connector.Modes {
			if mode.Preferred {
				return *connector, mode, nil
			}
		}
		return *connector, connector.Modes[0], nil
	}
	var best *ModeInfo
	for i := range connector.Modes {
		mode := &connector.Modes[i]
		if mode.Width != request.Width || mode.Height != request.Height || request.Refresh != 0 && mode.Refresh != request.Refresh {
			continue
		}
		if best == nil || mode.Preferred && !best.Preferred || mode.Preferred == best.Preferred && mode.Refresh > best.Refresh {
			best = mode
		}
	}
	if best == nil {
		return ConnectorInfo{}, ModeInfo{}, fmt.Errorf("DRM connector %q does not advertise mode %dx%d@%d", name, request.Width, request.Height, request.Refresh)
	}
	return *connector, *best, nil
}

// SelectCRTC selects an unused CRTC compatible with at least one encoder.
// Existing encoder routing is preferred when it remains available.
func SelectCRTC(crtcIDs []uint32, encoders []EncoderInfo, used map[uint32]bool) (uint32, error) {
	available := make(map[uint32]struct{}, len(crtcIDs))
	for _, id := range crtcIDs {
		available[id] = struct{}{}
	}
	for _, encoder := range encoders {
		if _, exists := available[encoder.CRTCID]; encoder.CRTCID != 0 && exists && !used[encoder.CRTCID] {
			return encoder.CRTCID, nil
		}
	}
	for _, encoder := range encoders {
		for index, id := range crtcIDs {
			if index < 32 && encoder.PossibleCRTCs&(uint32(1)<<index) != 0 && !used[id] {
				return id, nil
			}
		}
	}
	return 0, errors.New("no unused CRTC is compatible with the connector encoders")
}
