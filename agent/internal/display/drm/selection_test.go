package drm

import (
	"context"
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

func TestSelectConnectorMode(t *testing.T) {
	connectors := []ConnectorInfo{
		{Name: "HDMI-A-1", Connected: false},
		{Name: "HDMI-A-2", Connected: true, Modes: []ModeInfo{
			{Name: "1280x720", Width: 1280, Height: 720, Refresh: 60},
			{Name: "1920x1080", Width: 1920, Height: 1080, Refresh: 60, Preferred: true},
		}},
	}

	gotConnector, gotMode, err := SelectConnectorMode(connectors, "HDMI-A-2", display.ModeSpec{Width: 1280, Height: 720, Refresh: 60})
	if err != nil {
		t.Fatal(err)
	}
	if gotConnector.Name != "HDMI-A-2" || gotMode.Name != "1280x720" {
		t.Fatalf("selection = %s / %s", gotConnector.Name, gotMode.Name)
	}
	_, gotMode, err = SelectConnectorMode(connectors, "HDMI-A-2", display.ModeSpec{Preferred: true})
	if err != nil || gotMode.Name != "1920x1080" {
		t.Fatalf("preferred selection = %#v, %v", gotMode, err)
	}
}

func TestSelectConnectorModeReportsUnavailableTargets(t *testing.T) {
	connectors := []ConnectorInfo{
		{Name: "HDMI-A-1", Connected: false},
		{Name: "HDMI-A-2", Connected: true, Modes: []ModeInfo{{Name: "1280x720", Width: 1280, Height: 720, Refresh: 60}}},
	}
	tests := []struct {
		name      string
		connector string
		mode      display.ModeSpec
		want      string
	}{
		{name: "missing connector", connector: "HDMI-A-3", mode: display.ModeSpec{Preferred: true}, want: "not found"},
		{name: "disconnected connector", connector: "HDMI-A-1", mode: display.ModeSpec{Preferred: true}, want: "disconnected"},
		{name: "unsupported mode", connector: "HDMI-A-2", mode: display.ModeSpec{Width: 3840, Height: 2160}, want: "does not advertise mode"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := SelectConnectorMode(connectors, tt.connector, tt.mode)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("SelectConnectorMode() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestValidateTargetsMatchesConfiguredHardware(t *testing.T) {
	connectors := []Connector{{
		Card:              0,
		Name:              "HDMI-A-1",
		Device:            "/dev/dri/card0",
		DeviceNodePresent: true,
		Driver:            "vc4-drm",
		Status:            "connected",
		Modes:             []string{"1920x1080i", "1280x720"},
	}}
	targets := []DisplayTarget{{ID: "display-main", Connector: "HDMI-A-1", Mode: "1920x1080@60"}}

	if err := ValidateTargets("/dev/dri/card0", targets, connectors); err != nil {
		t.Fatalf("ValidateTargets() error = %v", err)
	}
}

func TestValidateTargetsAcceptsStableByPathDeviceAlias(t *testing.T) {
	deviceNumber, ok := deviceNodeNumber(os.DevNull)
	if !ok {
		t.Skip("character-device identity is available only on Linux")
	}
	alias := filepath.Join(t.TempDir(), "platform-gpu-card")
	if err := os.Symlink(os.DevNull, alias); err != nil {
		t.Fatal(err)
	}
	connector := Connector{
		Card:         0,
		Name:         "HDMI-A-1",
		Device:       "/dev/dri/card0",
		deviceNumber: deviceNumber,
		Status:       "connected",
		Modes:        []string{"1920x1080"},
	}
	target := DisplayTarget{ID: "display-main", Connector: "HDMI-A-1", Mode: "preferred"}

	if err := ValidateTargets(alias, []DisplayTarget{target}, []Connector{connector}); err != nil {
		t.Fatalf("ValidateTargets() rejected the stable alias for its owning card: %v", err)
	}

	wrongAlias := filepath.Join(t.TempDir(), "other-device")
	if err := os.Symlink("/dev/zero", wrongAlias); err != nil {
		t.Fatal(err)
	}
	if err := ValidateTargets(wrongAlias, []DisplayTarget{target}, []Connector{connector}); err == nil || !strings.Contains(err.Error(), "belongs to") {
		t.Fatalf("ValidateTargets() accepted an alias for a different device: %v", err)
	}
}

func TestValidateTargetsRejectsUnavailableOrMismatchedHardware(t *testing.T) {
	base := Connector{
		Card:              0,
		Name:              "HDMI-A-1",
		Device:            "/dev/dri/card0",
		DeviceNodePresent: true,
		Status:            "connected",
		Modes:             []string{"1920x1080"},
	}
	target := DisplayTarget{ID: "display-main", Connector: "HDMI-A-1", Mode: "1920x1080@60"}
	tests := []struct {
		name       string
		devicePath string
		targets    []DisplayTarget
		connectors []Connector
		wantError  string
	}{
		{name: "missing connector", devicePath: "/dev/dri/card0", targets: []DisplayTarget{target}, connectors: nil, wantError: "not found"},
		{name: "wrong card", devicePath: "/dev/dri/card1", targets: []DisplayTarget{target}, connectors: []Connector{base}, wantError: "belongs to"},
		{name: "missing device node", devicePath: "/dev/dri/card0", targets: []DisplayTarget{target}, connectors: []Connector{{Card: 0, Name: base.Name, Device: base.Device, Status: base.Status, Modes: base.Modes}}, wantError: "is missing"},
		{name: "disconnected connector", devicePath: "/dev/dri/card0", targets: []DisplayTarget{target}, connectors: []Connector{{Card: 0, Name: base.Name, Device: base.Device, DeviceNodePresent: true, Status: "disconnected", Modes: base.Modes}}, wantError: "disconnected"},
		{name: "no advertised modes", devicePath: "/dev/dri/card0", targets: []DisplayTarget{target}, connectors: []Connector{{Card: 0, Name: base.Name, Device: base.Device, DeviceNodePresent: true, Status: "connected"}}, wantError: "advertises no modes"},
		{name: "unsupported resolution", devicePath: "/dev/dri/card0", targets: []DisplayTarget{{ID: target.ID, Connector: target.Connector, Mode: "3840x2160"}}, connectors: []Connector{base}, wantError: "does not advertise resolution 3840x2160"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTargets(tt.devicePath, tt.targets, tt.connectors)
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("ValidateTargets() error = %v, want substring %q", err, tt.wantError)
			}
		})
	}
}

func TestSelectCRTCUsesCompatibleUnusedEncoder(t *testing.T) {
	crtcs := []uint32{40, 41}
	used := map[uint32]bool{40: true}
	got, err := SelectCRTC(crtcs, []EncoderInfo{{ID: 7, PossibleCRTCs: 0b11}}, used)
	if err != nil {
		t.Fatal(err)
	}
	if got != 41 {
		t.Fatalf("SelectCRTC() = %d, want unused CRTC 41", got)
	}
}

func TestOutputMapsLogicalDisplaysToConfiguredConnectors(t *testing.T) {
	device := &fakeKMSDevice{connectors: []ConnectorInfo{
		{Name: "HDMI-A-1", ID: 1, Connected: true, Modes: []ModeInfo{{Name: "1920x1080", Width: 1920, Height: 1080, Refresh: 60, Preferred: true}}},
		{Name: "HDMI-A-2", ID: 2, Connected: true, Modes: []ModeInfo{{Name: "1280x720", Width: 1280, Height: 720, Refresh: 60, Preferred: true}}},
	}}
	output, err := newOutputWithDevice(device, []DisplayTarget{
		{ID: "left", Connector: "HDMI-A-1", Mode: "preferred"},
		{ID: "right", Connector: "HDMI-A-2", Mode: "preferred"},
	}, display.FitContain)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	if len(device.opened) != 2 || device.opened[0].connector.Name != "HDMI-A-1" || device.opened[1].connector.Name != "HDMI-A-2" {
		t.Fatalf("opened surfaces = %#v", device.opened)
	}
	if device.opened[0].mode.Width != 1920 || device.opened[1].mode.Width != 1280 {
		t.Fatalf("opened modes = %#v / %#v", device.opened[0].mode, device.opened[1].mode)
	}
	frame := image.NewRGBA(image.Rect(0, 0, 1, 1))
	if err := output.Present(context.Background(), "right", frame); err != nil {
		t.Fatal(err)
	}
	if device.opened[0].surface.presented != 0 || device.opened[1].surface.presented != 1 {
		t.Fatalf("Present routed to %d / %d surfaces, want 0 / 1", device.opened[0].surface.presented, device.opened[1].surface.presented)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Present(context.Background(), "right", frame); err == nil {
		t.Fatal("Present() succeeded after Close()")
	}
}

func TestOutputCleansUpOnTargetFailure(t *testing.T) {
	device := &fakeKMSDevice{connectors: []ConnectorInfo{
		{Name: "HDMI-A-1", ID: 1, Connected: true, Modes: []ModeInfo{{Name: "1920x1080", Width: 1920, Height: 1080, Refresh: 60}}},
	}}
	_, err := newOutputWithDevice(device, []DisplayTarget{
		{ID: "left", Connector: "HDMI-A-1"},
		{ID: "right", Connector: "HDMI-A-2"},
	}, display.FitContain)
	if err == nil {
		t.Fatal("newOutputWithDevice() error = nil, want missing connector error")
	}
	if !device.closed || len(device.opened) != 1 || !device.opened[0].surface.closed {
		t.Fatalf("failed output was not cleaned up: %#v", device)
	}
}

func TestOutputRejectsModesAboveFramebufferBudget(t *testing.T) {
	device := &fakeKMSDevice{connectors: []ConnectorInfo{
		{Name: "HDMI-A-1", ID: 1, Connected: true, Modes: []ModeInfo{{Name: "8192x2049", Width: 8192, Height: 2049, Preferred: true}}},
	}}
	_, err := newOutputWithDevice(device, []DisplayTarget{{ID: "main", Connector: "HDMI-A-1", Mode: "preferred"}}, display.FitContain)
	if err == nil || !strings.Contains(err.Error(), "framebuffer limit") {
		t.Fatalf("newOutputWithDevice() error = %v, want framebuffer limit", err)
	}
	if !device.closed || len(device.opened) != 0 {
		t.Fatalf("oversized mode opened a surface or leaked the device: %#v", device)
	}
}

type fakeKMSDevice struct {
	connectors []ConnectorInfo
	opened     []fakeOpenedSurface
	closed     bool
}

type fakeOpenedSurface struct {
	connector ConnectorInfo
	mode      ModeInfo
	surface   *fakeSurface
}

func (device *fakeKMSDevice) Connectors() ([]ConnectorInfo, error) {
	return device.connectors, nil
}

func (device *fakeKMSDevice) OpenSurface(connector ConnectorInfo, mode ModeInfo, _ display.FitMode) (scanoutSurface, error) {
	surface := &fakeSurface{}
	device.opened = append(device.opened, fakeOpenedSurface{connector: connector, mode: mode, surface: surface})
	return surface, nil
}

func (device *fakeKMSDevice) Close() error {
	device.closed = true
	return nil
}

type fakeSurface struct {
	closed    bool
	presented int
}

func (surface *fakeSurface) Present(_ context.Context, _ image.Image) error {
	surface.presented++
	return nil
}
func (surface *fakeSurface) Close() error { surface.closed = true; return nil }
