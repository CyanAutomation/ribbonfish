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

// Agent owns the local playback loop and does not require network access.
type Agent struct {
	cache     cache.Store
	output    display.Output
	logger    *slog.Logger
	clock     Clock
	scheduler playlist.Scheduler
	displays  []preparedSchedule
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
	agent := &Agent{cache: imageCache, output: output, logger: logger, clock: clock}
	if ctx.Err() != nil {
		return agent, nil
	}

	// Protect manifest-pinned content before any cache writes can evict it.
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

	playlistEntries := make(map[string][]playlist.Entry, len(cfg.Playlists))
	retained := make(map[string]struct{})
	for _, playlistConfig := range cfg.Playlists {
		for _, source := range playlistConfig.Assets {
			if ctx.Err() != nil {
				break
			}
			if source.SHA256 != "" {
				digest := strings.ToLower(source.SHA256)
				if _, err := imageCache.Load(ctx, cache.Asset{SHA256: digest}); err == nil {
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
			playlistEntries[playlistConfig.ID] = append(playlistEntries[playlistConfig.ID], playlist.Entry{SHA256: asset.SHA256, Path: source.Path})
			retained[asset.SHA256] = struct{}{}
		}
	}
	if ctx.Err() == nil {
		if err := imageCache.Prune(ctx, sortedKeys(retained)); err != nil {
			return nil, fmt.Errorf("protect configured playlist assets in cache: %w", err)
		}
	}

	var schedules []playlist.Schedule
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
		schedules = append(schedules, playlist.Schedule{
			DisplayID: displayConfig.ID,
			Interval:  interval,
			Entries:   entries,
			Anchor:    time.Unix(0, 0).UTC(),
		})
	}
	if len(schedules) == 0 {
		logger.Warn("no displays have playable playlist images; waiting for shutdown")
		return agent, nil
	}
	scheduler, err := playlist.New(schedules)
	if err != nil {
		return nil, fmt.Errorf("create playlist scheduler: %w", err)
	}
	agent.scheduler = scheduler
	for _, schedule := range schedules {
		agent.displays = append(agent.displays, preparedSchedule{schedule: schedule})
	}
	return agent, nil
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
	for _, item := range a.displays {
		item := item
		wait.Add(1)
		go func() {
			defer wait.Done()
			a.runDisplay(ctx, item.schedule)
		}()
	}
	<-ctx.Done()
	wait.Wait()
	return nil
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

		next, err := a.scheduler.NextChange(schedule.DisplayID, a.clock.Now())
		if err != nil {
			a.logger.Error("could not calculate playlist rotation", "display_id", schedule.DisplayID, "error", err)
			return
		}
		wait := next.Sub(a.clock.Now())
		if wait <= 0 {
			wait = time.Millisecond
		}
		if err := a.clock.Wait(ctx, wait); err != nil && !errors.Is(err, context.Canceled) {
			a.logger.Error("playlist clock failed", "display_id", schedule.DisplayID, "error", err)
			return
		}
	}
}

func (a *Agent) currentFrame(ctx context.Context, schedule playlist.Schedule, at time.Time) (playlist.Entry, image.Image, bool) {
	current, err := a.scheduler.Current(schedule.DisplayID, at)
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

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
