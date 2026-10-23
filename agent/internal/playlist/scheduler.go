package playlist

import (
	"fmt"
	"time"
)

// Engine implements repeatable per-display playlist positions. A zero anchor
// is normalized to the Unix epoch, which keeps a display's phase stable after
// process restart.
type Engine struct {
	schedules map[string]Schedule
}

// New validates and copies the configured schedules.
func New(schedules []Schedule) (*Engine, error) {
	engine := &Engine{schedules: make(map[string]Schedule, len(schedules))}
	for _, schedule := range schedules {
		if schedule.DisplayID == "" {
			return nil, fmt.Errorf("playlist schedule display_id is required")
		}
		if schedule.Interval <= 0 {
			return nil, fmt.Errorf("display %q rotation interval must be greater than zero", schedule.DisplayID)
		}
		if len(schedule.Entries) == 0 {
			return nil, fmt.Errorf("display %q playlist must contain at least one entry", schedule.DisplayID)
		}
		if _, exists := engine.schedules[schedule.DisplayID]; exists {
			return nil, fmt.Errorf("display %q has more than one playlist schedule", schedule.DisplayID)
		}
		if schedule.Anchor.IsZero() {
			schedule.Anchor = time.Unix(0, 0).UTC()
		}
		schedule.Entries = append([]Entry(nil), schedule.Entries...)
		engine.schedules[schedule.DisplayID] = schedule
	}
	if len(engine.schedules) == 0 {
		return nil, fmt.Errorf("at least one playlist schedule is required")
	}
	return engine, nil
}

// Current returns the entry selected for the supplied instant.
func (e *Engine) Current(displayID string, at time.Time) (Entry, error) {
	schedule, ok := e.schedules[displayID]
	if !ok {
		return Entry{}, fmt.Errorf("unknown display %q", displayID)
	}
	elapsed := at.Sub(schedule.Anchor)
	if elapsed < 0 {
		return schedule.Entries[0], nil
	}
	slot := int64(elapsed / schedule.Interval)
	index := slot % int64(len(schedule.Entries))
	return schedule.Entries[index], nil
}

// NextChange returns the first schedule boundary after the supplied instant.
func (e *Engine) NextChange(displayID string, at time.Time) (time.Time, error) {
	schedule, ok := e.schedules[displayID]
	if !ok {
		return time.Time{}, fmt.Errorf("unknown display %q", displayID)
	}
	elapsed := at.Sub(schedule.Anchor)
	if elapsed < 0 {
		return schedule.Anchor, nil
	}
	remaining := schedule.Interval - elapsed%schedule.Interval
	return at.Add(remaining), nil
}
