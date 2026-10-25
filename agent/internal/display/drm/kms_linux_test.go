//go:build linux

package drm

import (
	"context"
	"image"
	"image/color"
	"testing"
	"time"
	"unsafe"
)

func TestDRMModeStructSizesMatchLinuxUAPI(t *testing.T) {
	tests := []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{name: "mode info", got: unsafe.Sizeof(drmModeModeInfo{}), want: 68},
		{name: "resource list", got: unsafe.Sizeof(drmModeCardResources{}), want: 64},
		{name: "connector", got: unsafe.Sizeof(drmModeGetConnector{}), want: 80},
		{name: "encoder", got: unsafe.Sizeof(drmModeGetEncoder{}), want: 20},
		{name: "CRTC", got: unsafe.Sizeof(drmModeCRTC{}), want: 104},
		{name: "create dumb", got: unsafe.Sizeof(drmModeCreateDumb{}), want: 32},
		{name: "map dumb", got: unsafe.Sizeof(drmModeMapDumb{}), want: 16},
		{name: "add framebuffer", got: unsafe.Sizeof(drmModeAddFB{}), want: 28},
		{name: "page flip", got: unsafe.Sizeof(drmModePageFlip{}), want: 24},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.got != tt.want {
				t.Fatalf("UAPI structure size = %d, want %d", tt.got, tt.want)
			}
		})
	}
}

func TestDRMIoctlRequestEncoding(t *testing.T) {
	if got, want := drmIO(drmIOCReadWrite, 64, ioctlModeGetResources), uintptr(0xc04064a0); got != want {
		t.Fatalf("GETRESOURCES ioctl = %#x, want %#x", got, want)
	}
	if got, want := drmIO(drmIOCNothing, 0, drmSetMaster), uintptr(0x641e); got != want {
		t.Fatalf("SET_MASTER ioctl = %#x, want %#x", got, want)
	}
}

func TestCopyXRGB8888UsesKernelPitchAndByteOrder(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 2, 1))
	frame.SetRGBA(0, 0, color.RGBA{R: 0x11, G: 0x22, B: 0x33, A: 0xff})
	frame.SetRGBA(1, 0, color.RGBA{R: 0xaa, G: 0xbb, B: 0xcc, A: 0xff})
	buffer := dumbBuffer{pitch: 12, size: 12, mapping: make([]byte, 12)}
	if err := copyXRGB8888(buffer, frame, 2, 1); err != nil {
		t.Fatal(err)
	}
	want := []byte{0x33, 0x22, 0x11, 0xff, 0xcc, 0xbb, 0xaa, 0xff, 0, 0, 0, 0}
	for i := range want {
		if buffer.mapping[i] != want[i] {
			t.Fatalf("byte %d = %#x, want %#x; data=%#v", i, buffer.mapping[i], want[i], buffer.mapping)
		}
	}
}

func TestCopyXRGB8888RejectsInsufficientBuffer(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 2, 1))
	if err := copyXRGB8888(dumbBuffer{pitch: 4, size: 4, mapping: make([]byte, 4)}, frame, 2, 1); err == nil {
		t.Fatal("copyXRGB8888() accepted a buffer smaller than the row width")
	}
}

func TestWaitForFramebufferFinishesPendingFlipAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reads := 0
	reached, err := waitForFramebuffer(ctx, time.Second, func() (uint32, error) {
		reads++
		if reads == 1 {
			cancel()
			return 1, nil
		}
		return 2, nil
	}, 2)
	if !reached || err != context.Canceled {
		t.Fatalf("waitForFramebuffer() = %t, %v; want completed target with cancellation", reached, err)
	}
}

func TestWaitForFramebufferTimesOutWithUncertainFlipState(t *testing.T) {
	reached, err := waitForFramebuffer(context.Background(), time.Millisecond, func() (uint32, error) {
		return 1, nil
	}, 2)
	if reached || err == nil {
		t.Fatalf("waitForFramebuffer() = %t, %v; want timeout", reached, err)
	}
}
