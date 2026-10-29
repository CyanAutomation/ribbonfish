package health

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTrackerProducesPrivacySafeDeviceSnapshot(t *testing.T) {
	started := time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC)
	tracker := NewTracker("agent-v1", "/nonexistent/ribbonfish-state", []OutputSpec{{DisplayID: "main", Connector: "HDMI-A-1"}}, func() time.Time { return started })
	tracker.SetAppliedSnapshot("operations", "rev-7")
	tracker.SetState("ready")
	tracker.SetSyncFailure("sync_unavailable")
	tracker.SetOutputState("main", "failed", "connector_disconnected")

	report := tracker.Snapshot(started.Add(42 * time.Second))
	if report.SchemaVersion != 1 || report.InstanceID == "" || report.AgentVersion != "agent-v1" || report.State != "degraded" {
		t.Fatalf("unexpected report identity/state: %#v", report)
	}
	if report.AgentUptimeSeconds != 42 || report.Sync.Status != "failed" || report.Sync.AppliedPlaylistID == nil || *report.Sync.AppliedPlaylistID != "operations" || report.Sync.AppliedRevision == nil || *report.Sync.AppliedRevision != "rev-7" {
		t.Fatalf("unexpected process/sync state: %#v", report)
	}
	if len(report.Outputs) != 1 || report.Outputs[0].Status != "failed" || report.Outputs[0].ErrorCode == nil || *report.Outputs[0].ErrorCode != "connector_disconnected" {
		t.Fatalf("unexpected output state: %#v", report.Outputs)
	}
	if strings.Contains(string(mustJSON(t, report)), "error") && strings.Contains(string(mustJSON(t, report)), "raw display error") {
		t.Fatal("health report contains raw error text")
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func assertErr(message string) error { return errors.New(message) }

func TestTrackerRecoversOnSyncAndSuccessfulFrame(t *testing.T) {
	clock := time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC)
	tracker := NewTracker("agent-v1", "/nonexistent", []OutputSpec{{DisplayID: "main"}}, func() time.Time { return clock })
	tracker.SetState("ready")
	tracker.SetSyncSuccess("operations", "rev-8")
	tracker.SetOutputState("main", "ready", "")
	clock = clock.Add(30 * time.Second)

	report := tracker.Snapshot(clock)
	if report.State != "ready" || report.Sync.Status != "ok" || report.Sync.LastSuccessAgeSeconds == nil || *report.Sync.LastSuccessAgeSeconds != 30 {
		t.Fatalf("unexpected healthy state: %#v", report)
	}
	if report.Outputs[0].LastFrameAgeSeconds == nil || *report.Outputs[0].LastFrameAgeSeconds != 30 {
		t.Fatalf("unexpected last frame age: %#v", report.Outputs[0])
	}
}

func TestErrorCodeMapsKnownFaultsAndNeverExposesMessages(t *testing.T) {
	if got := ErrorCode(assertErr("DRM connector HDMI-A-1 is disconnected: secret path")); got != "connector_disconnected" {
		t.Fatalf("ErrorCode() = %q", got)
	}
	if got := ErrorCode(assertErr("private file /home/pi/private.png failed to load")); got != "unknown" {
		t.Fatalf("unknown error code = %q", got)
	}
}
