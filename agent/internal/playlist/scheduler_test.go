package playlist

import (
	"testing"
	"time"
)

func TestSchedulerKeepsDisplayTimingIndependent(t *testing.T) {
	anchor := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	scheduler, err := New([]Schedule{
		{DisplayID: "left", Interval: 10 * time.Second, Entries: []Entry{{Path: "a"}, {Path: "b"}}, Anchor: anchor},
		{DisplayID: "right", Interval: 4 * time.Second, Entries: []Entry{{Path: "x"}, {Path: "y"}, {Path: "z"}}, Anchor: anchor},
	})
	if err != nil {
		t.Fatal(err)
	}

	at := anchor.Add(9 * time.Second)
	left, err := scheduler.Current("left", at)
	if err != nil {
		t.Fatal(err)
	}
	right, err := scheduler.Current("right", at)
	if err != nil {
		t.Fatal(err)
	}
	if left.Path != "a" || right.Path != "z" {
		t.Fatalf("Current() = (%q, %q), want independent positions (a, z)", left.Path, right.Path)
	}

	next, err := scheduler.NextChange("left", at)
	if err != nil || !next.Equal(anchor.Add(10*time.Second)) {
		t.Errorf("NextChange(left) = %v, %v", next, err)
	}
}

func TestSchedulerIsDeterministicAcrossRecreation(t *testing.T) {
	anchor := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	schedule := []Schedule{{DisplayID: "screen", Interval: time.Minute, Entries: []Entry{{Path: "one"}, {Path: "two"}, {Path: "three"}}, Anchor: anchor}}
	at := anchor.Add(121 * time.Second)
	first, err := New(schedule)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := New(schedule)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := first.Current("screen", at)
	b, _ := restarted.Current("screen", at)
	if a != b || a.Path != "three" {
		t.Fatalf("positions after restart = %#v and %#v, want third entry", a, b)
	}
}

func TestSchedulerRejectsInvalidSchedules(t *testing.T) {
	for _, schedule := range []Schedule{
		{DisplayID: "", Interval: time.Second, Entries: []Entry{{Path: "a"}}},
		{DisplayID: "screen", Interval: 0, Entries: []Entry{{Path: "a"}}},
		{DisplayID: "screen", Interval: time.Second},
	} {
		if _, err := New([]Schedule{schedule}); err == nil {
			t.Fatalf("New(%#v) error = nil", schedule)
		}
	}
	if _, err := New([]Schedule{{DisplayID: "screen", Interval: time.Second, Entries: []Entry{{Path: "a"}}}, {DisplayID: "screen", Interval: time.Second, Entries: []Entry{{Path: "b"}}}}); err == nil {
		t.Fatal("New() accepted duplicate display IDs")
	}
}
