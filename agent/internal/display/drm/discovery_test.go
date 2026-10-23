package drm

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestDiscoverReportsConnectorsAndTheirOwningDRMCard(t *testing.T) {
	sysfsRoot := t.TempDir()
	devRoot := filepath.Join(t.TempDir(), "dri")
	fixture := newDRMFixture(t, sysfsRoot, devRoot)
	fixture.addCard(0, "v3d")
	fixture.addCard(1, "vc4-drm")
	fixture.addConnector(1, "HDMI-A-1", "disconnected", nil)
	fixture.addConnector(1, "HDMI-A-2", "connected", []string{"1920x1080", "1280x720"})

	connectors, err := Discover(sysfsRoot, devRoot)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(connectors) != 2 {
		t.Fatalf("Discover() returned %d connectors, want 2: %#v", len(connectors), connectors)
	}

	want := []Connector{
		{
			Card:   1,
			Name:   "HDMI-A-1",
			Device: filepath.Join(devRoot, "card1"),
			Driver: "vc4-drm",
			Status: "disconnected",
			Modes:  []string{},
		},
		{
			Card:   1,
			Name:   "HDMI-A-2",
			Device: filepath.Join(devRoot, "card1"),
			Driver: "vc4-drm",
			Status: "connected",
			Modes:  []string{"1920x1080", "1280x720"},
		},
	}
	if !reflect.DeepEqual(connectors, want) {
		t.Fatalf("Discover() = %#v, want %#v", connectors, want)
	}
}

func TestDiscoverIgnoresDRMNodesWithoutConnectorStatus(t *testing.T) {
	sysfsRoot := t.TempDir()
	devRoot := filepath.Join(t.TempDir(), "dri")
	fixture := newDRMFixture(t, sysfsRoot, devRoot)
	fixture.addCard(0, "v3d")
	if err := os.MkdirAll(filepath.Join(sysfsRoot, "card0-Writeback-1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sysfsRoot, "renderD128"), 0o755); err != nil {
		t.Fatal(err)
	}

	connectors, err := Discover(sysfsRoot, devRoot)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(connectors) != 0 {
		t.Fatalf("Discover() = %#v, want no connectors", connectors)
	}
}

type drmFixture struct {
	t         *testing.T
	sysfsRoot string
	devRoot   string
}

func newDRMFixture(t *testing.T, sysfsRoot, devRoot string) drmFixture {
	t.Helper()
	return drmFixture{t: t, sysfsRoot: sysfsRoot, devRoot: devRoot}
}

func (f drmFixture) addCard(number int, driver string) {
	f.t.Helper()
	cardRoot := filepath.Join(f.sysfsRoot, "card"+strconv.Itoa(number))
	if err := os.MkdirAll(filepath.Join(cardRoot, "device"), 0o755); err != nil {
		f.t.Fatal(err)
	}
	driverPath := filepath.Join(f.sysfsRoot, "drivers", driver)
	if err := os.MkdirAll(driverPath, 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Symlink(driverPath, filepath.Join(cardRoot, "device", "driver")); err != nil {
		f.t.Fatal(err)
	}
}

func (f drmFixture) addConnector(card int, name, status string, modes []string) {
	f.t.Helper()
	connectorRoot := filepath.Join(f.sysfsRoot, "card"+strconv.Itoa(card)+"-"+name)
	if err := os.MkdirAll(connectorRoot, 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connectorRoot, "status"), []byte(status+"\n"), 0o644); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(connectorRoot, "modes"), []byte(strings.Join(modes, "\n")), 0o644); err != nil {
		f.t.Fatal(err)
	}
}
