//go:build linux

package drm

import (
	"context"
	"errors"
	"fmt"
	"image"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

const (
	drmIOCReadWrite = 3
	drmIOCNothing   = 0
	drmIOCTLType    = 'd'

	ioctlModeGetResources = 0xa0
	ioctlModeGetCRTC      = 0xa1
	ioctlModeSetCRTC      = 0xa2
	ioctlModeGetEncoder   = 0xa6
	ioctlModeGetConnector = 0xa7
	ioctlModeAddFB        = 0xae
	ioctlModeRMFB         = 0xaf
	ioctlModePageFlip     = 0xb0
	ioctlModeCreateDumb   = 0xb2
	ioctlModeMapDumb      = 0xb3
	ioctlModeDestroyDumb  = 0xb4

	drmSetMaster  = 0x1e
	drmDropMaster = 0x1f

	drmModePreferred = 1 << 3
	drmConnectionYes = 1
	drmPixelBytes    = 4
	maxDumbBuffer    = 128 * 1024 * 1024
	pageFlipTimeout  = 2 * time.Second
)

type drmModeModeInfo struct {
	Clock      uint32
	HDisplay   uint16
	HSyncStart uint16
	HSyncEnd   uint16
	HTotal     uint16
	HSkew      uint16
	VDisplay   uint16
	VSyncStart uint16
	VSyncEnd   uint16
	VTotal     uint16
	VScan      uint16
	VRefresh   uint32
	Flags      uint32
	Type       uint32
	Name       [32]byte
}

type drmModeCardResources struct {
	FBIDPtr         uint64
	CRTCIDPtr       uint64
	ConnectorIDPtr  uint64
	EncoderIDPtr    uint64
	CountFBs        uint32
	CountCRTCs      uint32
	CountConnectors uint32
	CountEncoders   uint32
	MinWidth        uint32
	MaxWidth        uint32
	MinHeight       uint32
	MaxHeight       uint32
}

type drmModeGetConnector struct {
	EncoderIDsPtr   uint64
	ModesPtr        uint64
	PropsPtr        uint64
	PropValuesPtr   uint64
	CountModes      uint32
	CountProps      uint32
	CountEncoders   uint32
	EncoderID       uint32
	ConnectorID     uint32
	ConnectorType   uint32
	ConnectorTypeID uint32
	Connection      uint32
	MMWidth         uint32
	MMHeight        uint32
	Subpixel        uint32
	Pad             uint32
}

type drmModeGetEncoder struct {
	EncoderID      uint32
	EncoderType    uint32
	CRTCID         uint32
	PossibleCRTCs  uint32
	PossibleClones uint32
}

type drmModeCRTC struct {
	SetConnectorsPtr uint64
	CountConnectors  uint32
	CRTCID           uint32
	FBID             uint32
	X                uint32
	Y                uint32
	GammaSize        uint32
	ModeValid        uint32
	Mode             drmModeModeInfo
}

type drmModeCreateDumb struct {
	Height uint32
	Width  uint32
	BPP    uint32
	Flags  uint32
	Handle uint32
	Pitch  uint32
	Size   uint64
}

type drmModeMapDumb struct {
	Handle uint32
	Pad    uint32
	Offset uint64
}

type drmModeDestroyDumb struct{ Handle uint32 }

type drmModeAddFB struct {
	FBID   uint32
	Width  uint32
	Height uint32
	Pitch  uint32
	BPP    uint32
	Depth  uint32
	Handle uint32
}

type drmModePageFlip struct {
	CRTCID   uint32
	FBID     uint32
	Flags    uint32
	Reserved uint32
	UserData uint64
}

type linuxKMSDevice struct {
	file      *os.File
	crtcIDs   []uint32
	usedCRTCs map[uint32]bool
	mu        sync.RWMutex
	closed    bool
}

type dumbBuffer struct {
	handle  uint32
	fbID    uint32
	pitch   uint32
	size    uint64
	mapping []byte
}

type linuxScanout struct {
	device     *linuxKMSDevice
	connector  uint32
	crtc       uint32
	mode       ModeInfo
	kernelMode drmModeModeInfo
	fit        display.FitMode
	mu         sync.Mutex
	buffers    [2]dumbBuffer
	active     int
	started    bool
	faulted    bool
	closed     bool
}

func openKMSDevice(path string) (outputDevice, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("DRM device path is required")
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("open DRM device %q: %w", path, err)
	}
	device := &linuxKMSDevice{file: file, usedCRTCs: make(map[uint32]bool)}
	if err := device.ioctl(drmIO(drmIOCNothing, 0, drmSetMaster), nil); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("become DRM master for %q (check device permissions and stop any other display server): %w", path, err)
	}
	resources, err := device.resources()
	if err != nil {
		_ = device.ioctl(drmIO(drmIOCNothing, 0, drmDropMaster), nil)
		_ = file.Close()
		return nil, fmt.Errorf("read DRM resources from %q: %w", path, err)
	}
	device.crtcIDs = resources.crtcs
	if len(resources.connectors) == 0 {
		_ = device.ioctl(drmIO(drmIOCNothing, 0, drmDropMaster), nil)
		_ = file.Close()
		return nil, fmt.Errorf("DRM device %q exposes no connectors", path)
	}
	return device, nil
}

func (device *linuxKMSDevice) Connectors() ([]ConnectorInfo, error) {
	resources, err := device.resources()
	if err != nil {
		return nil, err
	}
	connectors := make([]ConnectorInfo, 0, len(resources.connectors))
	for _, id := range resources.connectors {
		connector, err := device.connector(id)
		if err != nil {
			return nil, fmt.Errorf("read DRM connector %d: %w", id, err)
		}
		connectors = append(connectors, connector)
	}
	return connectors, nil
}

func (device *linuxKMSDevice) OpenSurface(connector ConnectorInfo, mode ModeInfo, fit display.FitMode) (scanoutSurface, error) {
	kernelMode, ok := mode.kernel.(drmModeModeInfo)
	if !ok {
		return nil, errors.New("selected DRM mode has no kernel timing data")
	}
	encoders := make([]EncoderInfo, 0, len(connector.Encoders))
	for _, id := range connector.Encoders {
		encoder, err := device.encoder(id)
		if err != nil {
			return nil, fmt.Errorf("read encoder %d: %w", id, err)
		}
		encoders = append(encoders, encoder)
	}
	device.mu.Lock()
	crtc, err := SelectCRTC(device.crtcIDs, encoders, device.usedCRTCs)
	if err == nil {
		device.usedCRTCs[crtc] = true
	}
	device.mu.Unlock()
	if err != nil {
		return nil, err
	}

	surface := &linuxScanout{device: device, connector: connector.ID, crtc: crtc, mode: mode, kernelMode: kernelMode, fit: fit}
	for index := range surface.buffers {
		buffer, err := device.createBuffer(int(mode.Width), int(mode.Height))
		if err != nil {
			_ = surface.Close()
			return nil, fmt.Errorf("allocate %dx%d scanout buffer: %w", mode.Width, mode.Height, err)
		}
		surface.buffers[index] = buffer
	}
	return surface, nil
}

func (device *linuxKMSDevice) Close() error {
	device.mu.Lock()
	defer device.mu.Unlock()
	if device.closed {
		return nil
	}
	var failures []error
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, device.file.Fd(), drmIO(drmIOCNothing, 0, drmDropMaster), 0)
	if errno != 0 {
		failures = append(failures, fmt.Errorf("drop DRM master: %w", errno))
	}
	device.closed = true
	if err := device.file.Close(); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

func (device *linuxKMSDevice) resources() (struct {
	crtcs      []uint32
	connectors []uint32
	encoders   []uint32
}, error) {
	var empty struct {
		crtcs      []uint32
		connectors []uint32
		encoders   []uint32
	}
	for attempt := 0; attempt < 3; attempt++ {
		var resources drmModeCardResources
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(resources), ioctlModeGetResources), unsafe.Pointer(&resources)); err != nil {
			return empty, err
		}
		fbIDs := make([]uint32, resources.CountFBs)
		crtcs := make([]uint32, resources.CountCRTCs)
		connectors := make([]uint32, resources.CountConnectors)
		encoders := make([]uint32, resources.CountEncoders)
		resources.FBIDPtr = slicePointer(fbIDs)
		resources.CRTCIDPtr = slicePointer(crtcs)
		resources.ConnectorIDPtr = slicePointer(connectors)
		resources.EncoderIDPtr = slicePointer(encoders)
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(resources), ioctlModeGetResources), unsafe.Pointer(&resources)); err != nil {
			return empty, err
		}
		runtime.KeepAlive(fbIDs)
		runtime.KeepAlive(crtcs)
		runtime.KeepAlive(connectors)
		runtime.KeepAlive(encoders)
		if resources.CountFBs <= uint32(len(fbIDs)) && resources.CountCRTCs <= uint32(len(crtcs)) && resources.CountConnectors <= uint32(len(connectors)) && resources.CountEncoders <= uint32(len(encoders)) {
			return struct {
				crtcs      []uint32
				connectors []uint32
				encoders   []uint32
			}{crtcs: crtcs[:resources.CountCRTCs], connectors: connectors[:resources.CountConnectors], encoders: encoders[:resources.CountEncoders]}, nil
		}
	}
	return empty, errors.New("DRM resource list changed repeatedly during discovery")
}

func (device *linuxKMSDevice) connector(id uint32) (ConnectorInfo, error) {
	for attempt := 0; attempt < 3; attempt++ {
		request := drmModeGetConnector{ConnectorID: id}
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeGetConnector), unsafe.Pointer(&request)); err != nil {
			return ConnectorInfo{}, err
		}
		modes := make([]drmModeModeInfo, request.CountModes)
		properties := make([]uint32, request.CountProps)
		propertyValues := make([]uint64, request.CountProps)
		encoders := make([]uint32, request.CountEncoders)
		request.ModesPtr = slicePointer(modes)
		request.PropsPtr = slicePointer(properties)
		request.PropValuesPtr = slicePointer(propertyValues)
		request.EncoderIDsPtr = slicePointer(encoders)
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeGetConnector), unsafe.Pointer(&request)); err != nil {
			return ConnectorInfo{}, err
		}
		runtime.KeepAlive(modes)
		runtime.KeepAlive(properties)
		runtime.KeepAlive(propertyValues)
		runtime.KeepAlive(encoders)
		if request.CountModes > uint32(len(modes)) || request.CountProps > uint32(len(properties)) || request.CountEncoders > uint32(len(encoders)) {
			continue
		}
		name := connectorName(request.ConnectorType, request.ConnectorTypeID)
		if name == "" {
			return ConnectorInfo{}, fmt.Errorf("connector type %d is unsupported", request.ConnectorType)
		}
		result := ConnectorInfo{
			Name: name, ID: id, Connected: request.Connection == drmConnectionYes,
			Encoders: encoders[:request.CountEncoders],
		}
		for _, mode := range modes[:request.CountModes] {
			result.Modes = append(result.Modes, ModeInfo{
				Name:      strings.TrimRight(string(mode.Name[:]), "\x00"),
				Width:     uint32(mode.HDisplay),
				Height:    uint32(mode.VDisplay),
				Refresh:   mode.VRefresh,
				Preferred: mode.Type&drmModePreferred != 0,
				kernel:    mode,
			})
		}
		return result, nil
	}
	return ConnectorInfo{}, errors.New("DRM connector list changed repeatedly during discovery")
}

func (device *linuxKMSDevice) encoder(id uint32) (EncoderInfo, error) {
	request := drmModeGetEncoder{EncoderID: id}
	if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeGetEncoder), unsafe.Pointer(&request)); err != nil {
		return EncoderInfo{}, err
	}
	return EncoderInfo{ID: id, CRTCID: request.CRTCID, PossibleCRTCs: request.PossibleCRTCs}, nil
}

func (device *linuxKMSDevice) createBuffer(width, height int) (dumbBuffer, error) {
	request := drmModeCreateDumb{Width: uint32(width), Height: uint32(height), BPP: 32}
	if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeCreateDumb), unsafe.Pointer(&request)); err != nil {
		return dumbBuffer{}, err
	}
	buffer := dumbBuffer{handle: request.Handle, pitch: request.Pitch, size: request.Size}
	if buffer.size == 0 || buffer.size > maxDumbBuffer || buffer.size > uint64(int(^uint(0)>>1)) {
		_ = device.destroyBuffer(&buffer)
		return dumbBuffer{}, fmt.Errorf("buffer size %d is outside the supported limit", buffer.size)
	}
	mapRequest := drmModeMapDumb{Handle: buffer.handle}
	if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(mapRequest), ioctlModeMapDumb), unsafe.Pointer(&mapRequest)); err != nil {
		_ = device.destroyBuffer(&buffer)
		return dumbBuffer{}, fmt.Errorf("map dumb buffer: %w", err)
	}
	mapping, err := syscall.Mmap(int(device.file.Fd()), int64(mapRequest.Offset), int(buffer.size), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		_ = device.destroyBuffer(&buffer)
		return dumbBuffer{}, fmt.Errorf("mmap dumb buffer: %w", err)
	}
	buffer.mapping = mapping
	framebuffer := drmModeAddFB{Width: uint32(width), Height: uint32(height), Pitch: buffer.pitch, BPP: 32, Depth: 24, Handle: buffer.handle}
	if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(framebuffer), ioctlModeAddFB), unsafe.Pointer(&framebuffer)); err != nil {
		_ = device.destroyBuffer(&buffer)
		return dumbBuffer{}, fmt.Errorf("register XRGB8888 framebuffer: %w", err)
	}
	buffer.fbID = framebuffer.FBID
	return buffer, nil
}

func (device *linuxKMSDevice) destroyBuffer(buffer *dumbBuffer) error {
	var failures []error
	if len(buffer.mapping) > 0 {
		if err := syscall.Munmap(buffer.mapping); err != nil {
			failures = append(failures, err)
		}
		buffer.mapping = nil
	}
	if buffer.fbID != 0 {
		fbID := buffer.fbID
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(fbID), ioctlModeRMFB), unsafe.Pointer(&fbID)); err != nil {
			failures = append(failures, fmt.Errorf("remove framebuffer %d: %w", fbID, err))
		}
		buffer.fbID = 0
	}
	if buffer.handle != 0 {
		request := drmModeDestroyDumb{Handle: buffer.handle}
		if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeDestroyDumb), unsafe.Pointer(&request)); err != nil {
			failures = append(failures, fmt.Errorf("destroy dumb buffer %d: %w", buffer.handle, err))
		}
		buffer.handle = 0
	}
	return errors.Join(failures...)
}

func (device *linuxKMSDevice) ioctl(request uintptr, argument unsafe.Pointer) error {
	device.mu.RLock()
	defer device.mu.RUnlock()
	if device.closed {
		return errors.New("DRM device is closed")
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, device.file.Fd(), request, uintptr(argument))
	runtime.KeepAlive(argument)
	if errno != 0 {
		return errno
	}
	return nil
}

func (surface *linuxScanout) Present(ctx context.Context, frame image.Image) error {
	surface.mu.Lock()
	defer surface.mu.Unlock()
	if surface.closed {
		return errors.New("DRM scanout surface is closed")
	}
	if surface.faulted {
		return errors.New("DRM scanout surface is faulted; restart required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if frame == nil {
		return errors.New("display frame is required")
	}
	rendered, err := display.FitImage(frame, int(surface.mode.Width), int(surface.mode.Height), surface.fit)
	if err != nil {
		return err
	}
	next := 0
	if surface.started {
		next = 1 - surface.active
	}
	if err := copyXRGB8888(surface.buffers[next], rendered, int(surface.mode.Width), int(surface.mode.Height)); err != nil {
		return err
	}
	if !surface.started {
		connectorID := surface.connector
		request := drmModeCRTC{
			SetConnectorsPtr: uint64(uintptr(unsafe.Pointer(&connectorID))),
			CountConnectors:  1,
			CRTCID:           surface.crtc,
			FBID:             surface.buffers[next].fbID,
			ModeValid:        1,
			Mode:             surface.kernelMode,
		}
		if err := surface.device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeSetCRTC), unsafe.Pointer(&request)); err != nil {
			return fmt.Errorf("set mode %dx%d on connector: %w", surface.mode.Width, surface.mode.Height, err)
		}
		runtime.KeepAlive(connectorID)
		surface.active = next
		surface.started = true
		return nil
	}
	request := drmModePageFlip{CRTCID: surface.crtc, FBID: surface.buffers[next].fbID}
	if err := surface.device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModePageFlip), unsafe.Pointer(&request)); err != nil {
		return fmt.Errorf("schedule display page flip: %w", err)
	}
	reached, err := waitForFramebuffer(ctx, pageFlipTimeout, func() (uint32, error) {
		return surface.device.currentFramebuffer(surface.crtc)
	}, surface.buffers[next].fbID)
	if reached {
		surface.active = next
	}
	if err != nil {
		if !reached {
			surface.faulted = true
		}
		return err
	}
	return nil
}

func waitForFramebuffer(ctx context.Context, timeout time.Duration, readCurrent func() (uint32, error), target uint32) (bool, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	cancelled := ctx.Done()
	var contextErr error
	for {
		current, err := readCurrent()
		if err != nil {
			return false, fmt.Errorf("read current DRM framebuffer: %w", err)
		}
		if current == target {
			if contextErr == nil {
				contextErr = ctx.Err()
			}
			return true, contextErr
		}
		select {
		case <-cancelled:
			contextErr = ctx.Err()
			cancelled = nil
		case <-deadline.C:
			return false, errors.Join(contextErr, fmt.Errorf("DRM page flip did not reach framebuffer %d within %s", target, timeout))
		case <-ticker.C:
		}
	}
}

func (device *linuxKMSDevice) currentFramebuffer(crtcID uint32) (uint32, error) {
	request := drmModeCRTC{CRTCID: crtcID}
	if err := device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeGetCRTC), unsafe.Pointer(&request)); err != nil {
		return 0, err
	}
	return request.FBID, nil
}

func (surface *linuxScanout) Close() error {
	surface.mu.Lock()
	defer surface.mu.Unlock()
	if surface.closed {
		return nil
	}
	surface.closed = true
	var failures []error
	if surface.started {
		request := drmModeCRTC{CRTCID: surface.crtc}
		if err := surface.device.ioctl(drmIO(drmIOCReadWrite, unsafe.Sizeof(request), ioctlModeSetCRTC), unsafe.Pointer(&request)); err != nil {
			failures = append(failures, fmt.Errorf("disable CRTC %d: %w", surface.crtc, err))
		}
		surface.started = false
	}
	for index := range surface.buffers {
		if err := surface.device.destroyBuffer(&surface.buffers[index]); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func copyXRGB8888(buffer dumbBuffer, frame *image.RGBA, width, height int) error {
	if buffer.pitch < uint32(width*drmPixelBytes) || uint64(buffer.pitch)*uint64(height) > buffer.size || uint64(buffer.pitch)*uint64(height) > uint64(len(buffer.mapping)) {
		return errors.New("DRM dumb buffer has an invalid pitch or size")
	}
	for y := 0; y < height; y++ {
		dst := buffer.mapping[y*int(buffer.pitch) : y*int(buffer.pitch)+width*drmPixelBytes]
		src := frame.Pix[y*frame.Stride : y*frame.Stride+width*4]
		for x := 0; x < width; x++ {
			dst[x*4] = src[x*4+2]
			dst[x*4+1] = src[x*4+1]
			dst[x*4+2] = src[x*4]
			dst[x*4+3] = 0xff
		}
	}
	return nil
}

func slicePointer[T any](values []T) uint64 {
	if len(values) == 0 {
		return 0
	}
	return uint64(uintptr(unsafe.Pointer(&values[0])))
}

func drmIO(direction, size uintptr, number uintptr) uintptr {
	return direction<<30 | size<<16 | uintptr(drmIOCTLType)<<8 | number
}

func connectorName(kind, typeID uint32) string {
	names := map[uint32]string{
		1: "VGA", 2: "DVI-I", 3: "DVI-D", 4: "DVI-A", 5: "Composite",
		6: "SVIDEO", 7: "LVDS", 8: "Component", 9: "DIN", 10: "DP",
		11: "HDMI-A", 12: "HDMI-B", 13: "TV", 14: "eDP", 15: "Virtual",
		16: "DSI", 17: "DPI", 18: "Writeback", 19: "SPI", 20: "USB",
	}
	name, ok := names[kind]
	if !ok || typeID == 0 {
		return ""
	}
	return fmt.Sprintf("%s-%d", name, typeID)
}
