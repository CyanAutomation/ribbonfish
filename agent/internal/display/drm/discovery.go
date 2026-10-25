// Package drm reports DRM/KMS connectors exposed by Linux sysfs.
package drm

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var connectorNamePattern = regexp.MustCompile(`^card([0-9]+)-(.+)$`)

// Connector describes one sysfs DRM connector and the primary device node
// that owns it. Modes is empty when the connector has no advertised modes.
type Connector struct {
	Card              int      `json:"card"`
	Name              string   `json:"name"`
	Device            string   `json:"device"`
	DeviceNodePresent bool     `json:"device_node_present"`
	Driver            string   `json:"driver"`
	Status            string   `json:"status"`
	Modes             []string `json:"modes"`
}

// Discover lists DRM connectors by reading sysfs. It does not open DRM
// devices, acquire DRM master, or attempt to change display modes.
func Discover(sysfsRoot, devRoot string) ([]Connector, error) {
	entries, err := os.ReadDir(sysfsRoot)
	if err != nil {
		return nil, fmt.Errorf("read DRM sysfs directory: %w", err)
	}

	connectors := make([]Connector, 0)
	for _, entry := range entries {
		match := connectorNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		cardNumber, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, fmt.Errorf("parse DRM card number in %q: %w", entry.Name(), err)
		}
		connectorRoot := filepath.Join(sysfsRoot, entry.Name())
		status, err := readTrimmed(filepath.Join(connectorRoot, "status"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read status for DRM connector %q: %w", entry.Name(), err)
		}
		modes, err := readLines(filepath.Join(connectorRoot, "modes"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("read modes for DRM connector %q: %w", entry.Name(), err)
		}
		if modes == nil {
			modes = []string{}
		}
		connectorName := match[2]
		device := filepath.Join(devRoot, "card"+strconv.Itoa(cardNumber))
		deviceInfo, statErr := os.Stat(device)
		deviceNodePresent := statErr == nil && deviceInfo.Mode()&os.ModeDevice != 0 && deviceInfo.Mode()&os.ModeCharDevice != 0
		connectors = append(connectors, Connector{
			Card:              cardNumber,
			Name:              connectorName,
			Device:            device,
			DeviceNodePresent: deviceNodePresent,
			Driver:            readDriver(filepath.Join(sysfsRoot, "card"+strconv.Itoa(cardNumber), "device", "driver")),
			Status:            status,
			Modes:             modes,
		})
	}

	sort.Slice(connectors, func(i, j int) bool {
		if connectors[i].Card != connectors[j].Card {
			return connectors[i].Card < connectors[j].Card
		}
		return connectors[i].Name < connectors[j].Name
	})
	return connectors, nil
}

func readDriver(path string) string {
	driver, err := os.Readlink(path)
	if err != nil {
		return "unknown"
	}
	return filepath.Base(driver)
}

func readTrimmed(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result, nil
}
