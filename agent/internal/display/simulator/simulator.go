// Package simulator implements the display output contract using atomic PNG
// files. It requires no graphics hardware or desktop environment.
package simulator

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
)

var displayIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Snapshot is an observable record of the most recently written frame.
type Snapshot struct {
	DisplayID string
	Path      string
	Sequence  uint64
	UpdatedAt time.Time
	Frame     image.Image
}

// Simulator implements display.Output by atomically replacing one PNG per
// logical display ID.
type Simulator struct {
	mu      sync.Mutex
	root    string
	states  map[string]Snapshot
	updates chan Snapshot
	closed  bool
}

var _ display.Output = (*Simulator)(nil)

// NewSimulator creates the output directory and returns a ready simulator.
func NewSimulator(outputDir string) (*Simulator, error) {
	if strings.TrimSpace(outputDir) == "" {
		return nil, errors.New("simulator output directory is required")
	}
	absolute, err := filepath.Abs(outputDir)
	if err != nil {
		return nil, fmt.Errorf("resolve simulator output directory: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		return nil, fmt.Errorf("create simulator output directory: %w", err)
	}
	return &Simulator{
		root:    absolute,
		states:  make(map[string]Snapshot),
		updates: make(chan Snapshot, 64),
	}, nil
}

// Present writes one complete PNG and then publishes the new state. Failures
// before the atomic rename leave the previous PNG and snapshot intact.
func (s *Simulator) Present(ctx context.Context, displayID string, frame image.Image) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !displayIDPattern.MatchString(displayID) {
		return fmt.Errorf("invalid display id %q", displayID)
	}
	if frame == nil {
		return errors.New("display frame is required")
	}
	bounds := frame.Bounds()
	if bounds.Empty() {
		return errors.New("display frame dimensions must be greater than zero")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("simulator is closed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	path := filepath.Join(s.root, displayID+".png")
	temporary, err := os.CreateTemp(s.root, ".ribbonfish-frame-")
	if err != nil {
		return fmt.Errorf("create temporary frame: %w", err)
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if err := png.Encode(temporary, frame); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("encode display frame: %w", err)
	}
	if err := ctx.Err(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync display frame: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close display frame: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("atomically replace display frame: %w", err)
	}

	previous := s.states[displayID]
	snapshot := Snapshot{
		DisplayID: displayID,
		Path:      path,
		Sequence:  previous.Sequence + 1,
		UpdatedAt: time.Now().UTC(),
		Frame:     clone(frame),
	}
	s.states[displayID] = snapshot
	select {
	case s.updates <- cloneSnapshot(snapshot):
	default:
		// The state map is authoritative; slow observers may miss notifications.
	}
	return nil
}

// Snapshot returns a copy of the latest state for one display.
func (s *Simulator) Snapshot(displayID string) (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, ok := s.states[displayID]
	if !ok {
		return Snapshot{}, false
	}
	return cloneSnapshot(snapshot), true
}

// Updates returns a best-effort stream of recent state changes for tests and
// local monitoring. Snapshot remains authoritative if the buffer fills.
func (s *Simulator) Updates() <-chan Snapshot {
	return s.updates
}

// Close prevents new frame writes and closes the update stream.
func (s *Simulator) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.updates)
	}
	return nil
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	snapshot.Frame = clone(snapshot.Frame)
	return snapshot
}

func clone(source image.Image) *image.RGBA {
	if source == nil {
		return nil
	}
	bounds := source.Bounds()
	copyFrame := image.NewRGBA(bounds)
	draw.Draw(copyFrame, bounds, source, bounds.Min, draw.Src)
	return copyFrame
}
