// Package agent composes validated configuration, the persistent cache,
// playlist scheduling, and a replaceable display backend.
package agent

import (
	"context"
	"errors"
	"fmt"
	"image"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/CyanAutomation/ribbonfish/agent/internal/cache"
	"github.com/CyanAutomation/ribbonfish/agent/internal/config"
	"github.com/CyanAutomation/ribbonfish/agent/internal/display"
	"github.com/CyanAutomation/ribbonfish/agent/internal/playlist"
)

// Clock makes playlist waits replaceable in deterministic tests.
type Clock interface {
	Now() time.Time
	Wait(context.Context, time.Duration) error
}

// RealClock is the production wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) Wait(ctx context.Context, duration time.Duration) error {
	if duration <= 0 {
		return nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type preparedSchedule struct {
	schedule playlist.Schedule
}

type playbackState struct {
	config    config.Config
	scheduler playlist.Scheduler
	displays  map[string]playlist.Schedule
	retained  []string
	readers   int
	idle      chan struct{}
}

// Agent owns the local playback loop and does not require network access.
type Agent struct {
	cache     cache.Store
	output    display.Output
	logger    *slog.Logger
	clock     Clock
	scheduler playlist.Scheduler
	displays  []preparedSchedule
	mu        sync.Mutex
	state     *playbackState
	changed   chan struct{}
}

// New verifies configured assets into the local cache and prepares independent
// display schedules. Missing, corrupt, or cache-full assets are skipped while
// other verified entries remain playable.
func New(ctx context.Context, cfg config.Config, imageCache cache.Store, output display.Output, logger *slog.Logger, clock Clock) (*Agent, error) {
	if ctx == nil {
		return nil, errors.New("agent context is required")
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate agent config: %w", err)
	}
	if imageCache == nil {
		return nil, errors.New("image cache is required")
	}
	if output == nil {
		return nil, errors.New("display output is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if clock == nil {
		clock = RealClock{}
	}
	state, err := prepareState(ctx, cfg, imageCache, logger, true, false)
	if err != nil {
		return nil, err
	}
	agent := &Agent{cache: imageCache, output: output, logger: logger, clock: clock, state: state, changed: make(chan struct{})}
	agent.scheduler = state.scheduler
	for _, schedule := range state.displays {
		agent.displays = append(agent.displays, preparedSchedule{schedule: schedule})
	}
	return agent, nil
}

func prepareState(ctx context.Context, cfg config.Config, imageCache cache.Store, logger *slog.Logger, pruneBefore, requireCachedAssets bool) (*playbackState, error) {
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate agent config: %w", err)
	}
	if ctx.Err() != nil {
		idle := make(chan struct{})
		close(idle)
		return &playbackState{config: cloneConfig(cfg), displays: map[string]playlist.Schedule{}, idle: idle}, nil
	}
	if pruneBefore {
		expected := make(map[string]struct{})
		for _, playlistConfig := range cfg.Playlists {
			for _, asset := range playlistConfig.Assets {
				if asset.SHA256 != "" {
					expected[strings.ToLower(asset.SHA256)] = struct{}{}
				}
			}
		}
		if len(expected) > 0 {
			if err := imageCache.Prune(ctx, sortedKeys(expected)); err != nil && ctx.Err() == nil {
				logger.Warn("could not prune cache before loading playlist assets", "error", err)
			}
		}
	}

	normalized := cloneConfig(cfg)
	playlistEntries := make(map[string][]playlist.Entry, len(cfg.Playlists))
	retained := make(map[string]struct{})
	for playlistIndex, playlistConfig := range cfg.Playlists {
		for assetIndex, source := range playlistConfig.Assets {
			if ctx.Err() != nil {
				break
			}
			if requireCachedAssets {
				if source.SHA256 == "" {
					return nil, fmt.Errorf("snapshot asset %q has no SHA-256 digest", source.Path)
				}
				digest := strings.ToLower(source.SHA256)
				if _, err := imageCache.Load(ctx, cache.Asset{SHA256: digest}); err != nil {
					return nil, fmt.Errorf("snapshot asset %s is unavailable or invalid: %w", digest, err)
				}
				normalized.Playlists[playlistIndex].Assets[assetIndex].SHA256 = digest
				playlistEntries[playlistConfig.ID] = append(playlistEntries[playlistConfig.ID], playlist.Entry{SHA256: digest, Path: source.Path})
				retained[digest] = struct{}{}
				continue
			}
			if source.SHA256 != "" {
				digest := strings.ToLower(source.SHA256)
				if _, err := imageCache.Load(ctx, cache.Asset{SHA256: digest}); err == nil {
					normalized.Playlists[playlistIndex].Assets[assetIndex].SHA256 = digest
					playlistEntries[playlistConfig.ID] = append(playlistEntries[playlistConfig.ID], playlist.Entry{SHA256: digest, Path: source.Path})
					retained[digest] = struct{}{}
					continue
				}
			}

			file, err := os.Open(source.Path)
			if err != nil {
				logger.Warn("playlist image is unavailable; skipping asset", "playlist_id", playlistConfig.ID, "path", source.Path, "error", err)
				continue
			}
			asset, putErr := imageCache.Put(ctx, file, source.SHA256)
			closeErr := file.Close()
			if putErr != nil {
				if ctx.Err() != nil {
					break
				}
				logger.Warn("playlist image could not be cached; skipping asset", "playlist_id", playlistConfig.ID, "path", source.Path, "error", putErr)
				continue
			}
			if closeErr != nil {
				logger.Warn("could not close playlist source image", "playlist_id", playlistConfig.ID, "path", source.Path, "error", closeErr)
			}
			normalized.Playlists[playlistIndex].Assets[assetIndex].SHA256 = asset.SHA256
			playlistEntries[playlistConfig.ID] = append(playlistEntries[playlistConfig.ID], playlist.Entry{SHA256: asset.SHA256, Path: source.Path})
			retained[asset.SHA256] = struct{}{}
		}
	}
	if pruneBefore && ctx.Err() == nil {
		if err := imageCache.Prune(ctx, sortedKeys(retained)); err != nil {
			return nil, fmt.Errorf("protect configured playlist assets in cache: %w", err)
		}
	}

	schedules := make(map[string]playlist.Schedule)
	var scheduleList []playlist.Schedule
	for _, displayConfig := range cfg.Displays {
		entries := playlistEntries[displayConfig.PlaylistID]
		if len(entries) == 0 {
			logger.Warn("display has no available playlist images; existing frame is preserved", "display_id", displayConfig.ID, "playlist_id", displayConfig.PlaylistID)
			continue
		}
		interval, err := displayConfig.Interval()
		if err != nil {
			return nil, err
		}
		schedule := playlist.Schedule{DisplayID: displayConfig.ID, Interval: interval, Entries: entries, Anchor: time.Unix(0, 0).UTC()}
		schedules[displayConfig.ID] = schedule
		scheduleList = append(scheduleList, schedule)
	}
	var scheduler playlist.Scheduler
	var err error
	if len(scheduleList) == 0 {
		logger.Warn("no displays have playable playlist images; waiting for shutdown")
	} else {
		scheduler, err = playlist.New(scheduleList)
		if err != nil {
			return nil, fmt.Errorf("create playlist scheduler: %w", err)
		}
	}
	idle := make(chan struct{})
	close(idle)
	return &playbackState{config: normalized, scheduler: scheduler, displays: schedules, retained: sortedKeys(retained), idle: idle}, nil
}

// Run starts one independent playback loop per configured display and waits
// for context cancellation. Displays with no available assets are left at
// their last successfully written frame.
func (a *Agent) Run(ctx context.Context) error {
	if ctx == nil {
		return errors.New("agent context is required")
	}
	if ctx.Err() != nil {
		return nil
	}
	var wait sync.WaitGroup
	a.mu.Lock()
	state := a.state
	if state != nil {
		for _, displayConfig := range state.config.Displays {
			displayID := displayConfig.ID
			wait.Add(1)
			go func() {
				defer wait.Done()
				a.runDynamicDisplay(ctx, displayID)
			}()
		}
		a.mu.Unlock()
	} else {
		displays := append([]preparedSchedule(nil), a.displays...)
		a.mu.Unlock()
		for _, item := range displays {
			item := item
			wait.Add(1)
			go func() {
				defer wait.Done()
				a.runDisplay(ctx, item.schedule)
			}()
		}
	}
	<-ctx.Done()
	wait.Wait()
	return nil
}

// CurrentConfig returns the local settings combined with the active content
// snapshot. The returned slices are independent of the live agent state.
func (a *Agent) CurrentConfig() config.Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.state == nil {
		return config.Config{}
	}
	return cloneConfig(a.state.config)
}

// ApplyConfig switches playlists after all referenced content is available in
// the cache. The output and hardware mapping cannot be changed by a remote
// snapshot. Old cache entries remain pinned until playback leaves the prior
// snapshot, then normal cache pruning removes them.
func (a *Agent) ApplyConfig(ctx context.Context, cfg config.Config) error {
	if ctx == nil {
		return errors.New("agent context is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	candidate, err := prepareState(ctx, cfg, a.cache, a.logger, false, true)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if err := ctx.Err(); err != nil {
		a.mu.Unlock()
		return err
	}
	previous := a.state
	if previous == nil {
		a.mu.Unlock()
		return errors.New("agent has no active playback state")
	}
	if !sameHardware(previous.config, candidate.config) {
		a.mu.Unlock()
		return errors.New("content update attempted to change local hardware settings")
	}
	a.state = candidate
	if a.changed == nil {
		a.changed = make(chan struct{})
	}
	close(a.changed)
	a.changed = make(chan struct{})
	previousIdle := previous.idle
	a.mu.Unlock()

	select {
	case <-previousIdle:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := a.cache.Prune(ctx, candidate.retained); err != nil {
		// Playback is already on the new snapshot. Keeping extra cache entries is
		// safe; the bounded cache will report a failure if future assets cannot fit.
		a.logger.Warn("could not prune images from the previous snapshot", "error", err)
	}
	return nil
}

func (a *Agent) acquireState(displayID string) (*playbackState, playlist.Schedule, <-chan struct{}) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state := a.state
	if state == nil {
		return nil, playlist.Schedule{}, a.changed
	}
	schedule, ok := state.displays[displayID]
	if !ok {
		return state, playlist.Schedule{}, a.changed
	}
	if state.readers == 0 {
		state.idle = make(chan struct{})
	}
	state.readers++
	return state, schedule, a.changed
}

func (a *Agent) releaseState(state *playbackState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state.readers--
	if state.readers == 0 {
		close(state.idle)
	}
}

func (a *Agent) runDynamicDisplay(ctx context.Context, displayID string) {
	lastDisplayed := ""
	for ctx.Err() == nil {
		state, schedule, changed := a.acquireState(displayID)
		if state == nil {
			return
		}
		if schedule.DisplayID == "" {
			select {
			case <-changed:
				continue
			case <-ctx.Done():
				return
			}
		}
		now := a.clock.Now()
		entry, frame, available := a.currentFrameFor(ctx, state.scheduler, schedule, now)
		if available && entry.SHA256 != lastDisplayed {
			if err := a.output.Present(ctx, displayID, frame); err != nil {
				if ctx.Err() == nil {
					a.logger.Error("could not present display frame; keeping last good output", "display_id", displayID, "error", err)
				}
			} else {
				lastDisplayed = entry.SHA256
				a.logger.Info("display frame updated", "display_id", displayID, "asset_sha256", entry.SHA256)
			}
		}
		now = a.clock.Now()
		next, err := state.scheduler.NextChange(displayID, now)
		if err != nil {
			a.releaseState(state)
			a.logger.Error("could not calculate playlist rotation", "display_id", displayID, "error", err)
			return
		}
		wait := next.Sub(now)
		if wait <= 0 {
			wait = time.Millisecond
		}
		a.releaseState(state)
		if err := waitForChange(ctx, changed, a.clock, wait); err != nil && ctx.Err() == nil {
			a.logger.Error("playlist clock failed", "display_id", displayID, "error", err)
			return
		}
	}
}

func waitForChange(ctx context.Context, changed <-chan struct{}, clock Clock, duration time.Duration) error {
	waitCtx, cancel := context.WithCancel(ctx)
	finished := make(chan struct{})
	go func() {
		select {
		case <-changed:
			cancel()
		case <-finished:
		}
	}()
	err := clock.Wait(waitCtx, duration)
	close(finished)
	cancel()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case <-changed:
		return nil
	default:
	}
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (a *Agent) runDisplay(ctx context.Context, schedule playlist.Schedule) {
	lastDisplayed := ""
	for ctx.Err() == nil {
		now := a.clock.Now()
		entry, frame, available := a.currentFrame(ctx, schedule, now)
		if available && entry.SHA256 != lastDisplayed {
			if err := a.output.Present(ctx, schedule.DisplayID, frame); err != nil {
				if ctx.Err() == nil {
					a.logger.Error("could not present display frame; keeping last good output", "display_id", schedule.DisplayID, "error", err)
				}
			} else {
				lastDisplayed = entry.SHA256
				a.logger.Info("display frame updated", "display_id", schedule.DisplayID, "asset_sha256", entry.SHA256)
			}
		}

		// Account for work spent loading and presenting the current frame, then
		// use one snapshot for both the boundary and the wait calculation.
		now = a.clock.Now()
		next, err := a.scheduler.NextChange(schedule.DisplayID, now)
		if err != nil {
			a.logger.Error("could not calculate playlist rotation", "display_id", schedule.DisplayID, "error", err)
			return
		}
		wait := next.Sub(now)
		if wait <= 0 {
			wait = time.Millisecond
		}
		if err := a.clock.Wait(ctx, wait); err != nil && ctx.Err() == nil {
			a.logger.Error("playlist clock failed", "display_id", schedule.DisplayID, "error", err)
			return
		}
	}
}

func (a *Agent) currentFrame(ctx context.Context, schedule playlist.Schedule, at time.Time) (playlist.Entry, image.Image, bool) {
	return a.currentFrameFor(ctx, a.scheduler, schedule, at)
}

func (a *Agent) currentFrameFor(ctx context.Context, scheduler playlist.Scheduler, schedule playlist.Schedule, at time.Time) (playlist.Entry, image.Image, bool) {
	current, err := scheduler.Current(schedule.DisplayID, at)
	if err != nil {
		a.logger.Error("could not select playlist asset", "display_id", schedule.DisplayID, "error", err)
		return playlist.Entry{}, nil, false
	}
	start := 0
	for i, entry := range schedule.Entries {
		if entry == current {
			start = i
			break
		}
	}
	for offset := 0; offset < len(schedule.Entries); offset++ {
		entry := schedule.Entries[(start+offset)%len(schedule.Entries)]
		frame, err := a.cache.Load(ctx, cache.Asset{SHA256: entry.SHA256})
		if err != nil {
			if ctx.Err() == nil {
				a.logger.Warn("playlist image failed cache verification; trying next asset", "display_id", schedule.DisplayID, "asset_sha256", entry.SHA256, "error", err)
			}
			continue
		}
		return entry, frame, true
	}
	return playlist.Entry{}, nil, false
}

func sameHardware(left, right config.Config) bool {
	if left.Cache.Directory != right.Cache.Directory || left.Cache.MaxBytes != right.Cache.MaxBytes ||
		left.Output.EffectiveBackend() != right.Output.EffectiveBackend() || left.Output.Directory != right.Output.Directory ||
		left.Output.Device != right.Output.Device || left.Output.EffectiveFit() != right.Output.EffectiveFit() ||
		len(left.Displays) != len(right.Displays) {
		return false
	}
	rightDisplays := make(map[string]config.DisplayConfig, len(right.Displays))
	for _, item := range right.Displays {
		rightDisplays[item.ID] = item
	}
	for _, item := range left.Displays {
		other, ok := rightDisplays[item.ID]
		if !ok || item.Connector != other.Connector || item.Mode != other.Mode {
			return false
		}
	}
	return true
}

func cloneConfig(source config.Config) config.Config {
	clone := source
	clone.Playlists = append([]config.PlaylistConfig(nil), source.Playlists...)
	for i := range clone.Playlists {
		clone.Playlists[i].Assets = append([]config.AssetConfig(nil), source.Playlists[i].Assets...)
	}
	clone.Displays = append([]config.DisplayConfig(nil), source.Displays...)
	return clone
}

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
