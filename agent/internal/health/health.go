// Package health collects privacy-safe runtime state for the management API.
package health

import (
	"crypto/rand"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type OutputSpec struct {
	DisplayID string
	Connector string
}

type Report struct {
	SchemaVersion      int            `json:"schema_version"`
	InstanceID         string         `json:"instance_id"`
	AgentVersion       string         `json:"agent_version"`
	State              string         `json:"state"`
	AgentUptimeSeconds uint64         `json:"agent_uptime_seconds"`
	StartupErrorCode   string         `json:"startup_error_code,omitempty"`
	Sync               SyncReport     `json:"sync"`
	Outputs            []OutputReport `json:"outputs"`
	Host               *HostReport    `json:"host,omitempty"`
}

type SyncReport struct {
	Status                string  `json:"status"`
	AppliedPlaylistID     *string `json:"applied_playlist_id"`
	AppliedRevision       *string `json:"applied_revision"`
	LastSuccessAgeSeconds *uint64 `json:"last_success_age_seconds"`
	ErrorCode             *string `json:"error_code"`
}

type OutputReport struct {
	DisplayID           string  `json:"display_id"`
	Connector           *string `json:"connector"`
	Status              string  `json:"status"`
	LastFrameAgeSeconds *uint64 `json:"last_frame_age_seconds"`
	ErrorCode           *string `json:"error_code"`
}

type HostReport struct {
	UptimeSeconds           *uint64  `json:"uptime_seconds,omitempty"`
	Load1m                  *float64 `json:"load_1m,omitempty"`
	MemoryAvailableBytes    *uint64  `json:"memory_available_bytes,omitempty"`
	StateDiskFreeBytes      *uint64  `json:"state_disk_free_bytes,omitempty"`
	TemperatureMilliCelsius *int64   `json:"temperature_millicelsius,omitempty"`
}

type outputState struct {
	spec      OutputSpec
	status    string
	errorCode string
	lastFrame time.Time
}

// Tracker is safe to update from playback and synchronization goroutines.
type Tracker struct {
	mu          sync.Mutex
	startedAt   time.Time
	now         func() time.Time
	instanceID  string
	version     string
	stateDir    string
	state       string
	startupCode string
	syncStatus  string
	syncCode    string
	playlistID  string
	revision    string
	lastSync    time.Time
	outputs     map[string]*outputState
	changed     chan struct{}
}

func NewTracker(version, stateDir string, specs []OutputSpec, clock func() time.Time) *Tracker {
	if len(specs) > 8 {
		specs = specs[:8]
	}
	if clock == nil {
		clock = time.Now
	}
	now := clock()
	instanceID := newInstanceID()
	if version == "" {
		version = "unknown"
	}
	t := &Tracker{
		startedAt: now, now: clock, instanceID: instanceID, version: version,
		stateDir: stateDir, state: "starting", syncStatus: "unknown",
		outputs: make(map[string]*outputState, len(specs)), changed: make(chan struct{}, 1),
	}
	for _, spec := range specs {
		connector := strings.TrimSpace(spec.Connector)
		spec.Connector = connector
		t.outputs[spec.DisplayID] = &outputState{spec: spec, status: "unknown"}
	}
	return t
}

func newInstanceID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return strconv.FormatInt(time.Now().UnixNano(), 16)
}

func (t *Tracker) Changes() <-chan struct{} { return t.changed }

func (t *Tracker) SetState(state string) {
	if state != "starting" && state != "ready" && state != "degraded" && state != "startup_failed" && state != "stopping" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != state || (state != "startup_failed" && t.startupCode != "") {
		t.state = state
		if state != "startup_failed" {
			t.startupCode = ""
		}
		t.signalLocked()
	}
}

func (t *Tracker) SetStartupFailure(code string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.state = "startup_failed"
	t.startupCode = safeCode(code)
	t.signalLocked()
}

func (t *Tracker) SetAppliedSnapshot(playlistID, revision string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.playlistID != playlistID || t.revision != revision {
		t.playlistID, t.revision = playlistID, revision
		t.signalLocked()
	}
}

func (t *Tracker) SetSyncSuccess(playlistID, revision string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.syncStatus != "ok" || t.syncCode != "" || t.playlistID != playlistID || t.revision != revision {
		t.signalLocked()
	}
	t.syncStatus, t.syncCode = "ok", ""
	t.playlistID, t.revision = playlistID, revision
	t.lastSync = t.now()
}

func (t *Tracker) SetSyncFailure(code string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	code = safeCode(code)
	if t.syncStatus != "failed" || t.syncCode != code {
		t.signalLocked()
	}
	t.syncStatus, t.syncCode = "failed", code
}

// SetOutputState updates the connector status. A ready update also records the
// time the most recent frame reached the output, even when status did not change.
func (t *Tracker) SetOutputState(displayID, status, code string) {
	if status != "unknown" && status != "ready" && status != "failed" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	output := t.outputs[displayID]
	if output == nil {
		return
	}
	if status == "failed" {
		code = safeCode(code)
	} else {
		code = ""
	}
	if status == "ready" {
		output.lastFrame = t.now()
	}
	if output.status != status || output.errorCode != code {
		output.status, output.errorCode = status, code
		t.signalLocked()
	}
}

func (t *Tracker) Snapshot(now time.Time) Report {
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.IsZero() {
		now = t.now()
	}
	state := t.state
	if state == "ready" {
		if t.syncStatus == "failed" || hasFailedOutput(t.outputs) {
			state = "degraded"
		}
	}
	outputs := make([]OutputReport, 0, len(t.outputs))
	ids := make([]string, 0, len(t.outputs))
	for id := range t.outputs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		item := t.outputs[id]
		var connector *string
		if item.spec.Connector != "" {
			value := item.spec.Connector
			connector = &value
		}
		var age *uint64
		if !item.lastFrame.IsZero() {
			value := secondsSince(now, item.lastFrame)
			age = &value
		}
		outputs = append(outputs, OutputReport{
			DisplayID: id, Connector: connector, Status: item.status,
			LastFrameAgeSeconds: age, ErrorCode: nullableCode(item.errorCode),
		})
	}
	var playlistID, revision *string
	if t.playlistID != "" {
		value := t.playlistID
		playlistID = &value
	}
	if t.revision != "" {
		value := t.revision
		revision = &value
	}
	var syncAge *uint64
	if !t.lastSync.IsZero() {
		value := secondsSince(now, t.lastSync)
		syncAge = &value
	}
	return Report{
		SchemaVersion: 1, InstanceID: t.instanceID, AgentVersion: t.version,
		State: state, AgentUptimeSeconds: secondsSince(now, t.startedAt),
		StartupErrorCode: t.startupCode,
		Sync: SyncReport{Status: t.syncStatus, AppliedPlaylistID: playlistID, AppliedRevision: revision,
			LastSuccessAgeSeconds: syncAge, ErrorCode: nullableCode(t.syncCode)},
		Outputs: outputs, Host: collectHost(t.stateDir),
	}
}

func hasFailedOutput(outputs map[string]*outputState) bool {
	for _, item := range outputs {
		if item.status == "failed" {
			return true
		}
	}
	return false
}

func secondsSince(now, then time.Time) uint64 {
	seconds := now.Sub(then).Seconds()
	if seconds <= 0 {
		return 0
	}
	return uint64(seconds)
}

func (t *Tracker) signalLocked() {
	select {
	case t.changed <- struct{}{}:
	default:
	}
}

func safeCode(code string) string {
	switch code {
	case "asset_unavailable", "cache_full", "configuration_invalid", "connector_disconnected",
		"connector_mode_unsupported", "display_start_failed", "drm_open_failed", "frame_present_failed",
		"no_playable_assets", "sync_rejected", "sync_unavailable", "unknown":
		return code
	default:
		return "unknown"
	}
}

func nullableCode(code string) *string {
	if code == "" {
		return nil
	}
	value := safeCode(code)
	return &value
}

// ErrorCode converts implementation errors to the small public health vocabulary.
func ErrorCode(err error) string {
	if err == nil {
		return "unknown"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "disconnect") || strings.Contains(message, "not connected") ||
		strings.Contains(message, "connector") && strings.Contains(message, "not found"):
		return "connector_disconnected"
	case strings.Contains(message, "does not advertise") || strings.Contains(message, "mode unsupported") || strings.Contains(message, "no display modes"):
		return "connector_mode_unsupported"
	case strings.Contains(message, "no playable assets"):
		return "no_playable_assets"
	case strings.Contains(message, "cache full") || strings.Contains(message, "no space left"):
		return "cache_full"
	case strings.Contains(message, "image") || strings.Contains(message, "asset"):
		return "asset_unavailable"
	case strings.Contains(message, "drm") || strings.Contains(message, "/dev/dri"):
		return "drm_open_failed"
	case strings.Contains(message, "present") || strings.Contains(message, "frame"):
		return "frame_present_failed"
	default:
		return "unknown"
	}
}

func collectHost(stateDir string) *HostReport {
	host := &HostReport{}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			if value, err := strconv.ParseFloat(fields[0], 64); err == nil && value >= 0 && value <= 10_000_000_000 {
				seconds := uint64(value)
				host.UptimeSeconds = &seconds
			}
		}
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			if value, err := strconv.ParseFloat(fields[0], 64); err == nil && !math.IsInf(value, 0) && !math.IsNaN(value) && value >= 0 && value <= 1000 {
				host.Load1m = &value
			}
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.HasPrefix(line, "MemAvailable:") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if value, err := strconv.ParseUint(fields[1], 10, 64); err == nil && value <= (1<<53-1)/1024 {
					bytes := value * 1024
					host.MemoryAvailableBytes = &bytes
				}
			}
			break
		}
	}
	if raw, err := os.ReadFile("/sys/class/thermal/thermal_zone0/temp"); err == nil {
		if value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil && value >= -40_000 && value <= 150_000 {
			host.TemperatureMilliCelsius = &value
		}
	}
	if stateDir != "" {
		if info, err := os.Stat(filepath.Clean(stateDir)); err == nil && info.IsDir() {
			var stats syscall.Statfs_t
			if err := syscall.Statfs(stateDir, &stats); err == nil && stats.Bsize >= 0 && stats.Bavail <= (1<<53-1)/uint64(max(stats.Bsize, 1)) {
				bytes := stats.Bavail * uint64(stats.Bsize)
				host.StateDiskFreeBytes = &bytes
			}
		}
	}
	if host.UptimeSeconds == nil && host.Load1m == nil && host.MemoryAvailableBytes == nil && host.StateDiskFreeBytes == nil && host.TemperatureMilliCelsius == nil {
		return nil
	}
	return host
}
