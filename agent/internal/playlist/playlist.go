// Package playlist defines deterministic scheduling contracts.
package playlist

import (
	"context"
	"time"
)

// Entry is one item in its configured playlist order.
type Entry struct {
	SHA256 string
	Path   string
}

// Schedule is the rotation contract for one independent display.
type Schedule struct {
	DisplayID string
	Interval  time.Duration
	Entries   []Entry
	Anchor    time.Time
}

// Scheduler provides repeatable playlist positions for a wall-clock instant.
// Supplying the instant explicitly makes rotation deterministic in tests and
// lets a restarted process recover the same position without persisted timers.
type Scheduler interface {
	Current(displayID string, at time.Time) (Entry, error)
	NextChange(displayID string, at time.Time) (time.Time, error)
}

// Runner starts the playback loop and returns when its context is cancelled.
type Runner interface {
	Run(context.Context) error
}
