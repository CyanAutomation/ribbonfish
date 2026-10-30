//go:build linux

package drm

import (
	"fmt"
	"os"
	"syscall"
)

func deviceNodeNumber(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || info.Mode()&os.ModeDevice == 0 || info.Mode()&os.ModeCharDevice == 0 {
		return "", false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", false
	}
	major, minor := linuxDeviceNumbers(uint64(stat.Rdev))
	return fmt.Sprintf("%d:%d", major, minor), true
}

func linuxDeviceNumbers(device uint64) (major, minor uint64) {
	major = (device >> 8) & 0xfff
	major |= (device >> 32) & 0xfffff000
	minor = device & 0xff
	minor |= (device >> 12) & 0xffffff00
	return major, minor
}
