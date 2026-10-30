//go:build !linux

package drm

func DeviceNodeNumber(string) (string, bool) {
	return "", false
}
