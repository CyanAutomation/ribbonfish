//go:build !linux

package drm

import (
	"errors"
)

func openKMSDevice(string) (outputDevice, error) {
	return nil, errors.New("DRM/KMS output is supported only on Linux")
}
