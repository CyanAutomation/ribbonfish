//go:build !linux

package drm

func deviceNodeNumber(string) (string, bool) {
	return "", false
}
