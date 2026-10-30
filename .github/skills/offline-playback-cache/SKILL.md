---
name: offline-playback-cache
description: Change or diagnose Ribbonfish's persistent image cache, deterministic playlists, simulator output, and offline playback behavior.
tags: [ribbonfish, go, cache, playback, offline]
relatedSkills: [go-agent-development, container-smoke-testing, raspberry-pi-deployment]
---

# Offline Playback and Cache

Use this skill when work touches `agent/internal/cache`, `agent/internal/playlist`, `agent/internal/agent`, the simulator, or the local playback examples.

## Runtime invariants

- The device cache is separate from Cloudflare R2 retention and reconciliation. The local cache is bounded by its configured byte limit and keys image content by SHA-256.
- `Put` checks an optional expected digest, validates the image before installation, and uses a temporary file plus atomic rename. `Load` verifies content before decoding it.
- PNG, JPEG, and GIF are supported by the current standard-library decoders. Decoding rejects images above the cache package's 32-megapixel limit.
- Active playlist content is protected from eviction. The cache evicts least-recently-used unprotected assets; if the configured assets cannot fit, the agent skips unavailable items and keeps other verified assets playable.
- Cache recovery discards interrupted temporary files, validates indexed content, and re-indexes valid orphaned image files.
- Each display has its own ordered playlist and rotation interval. The scheduler calculates the current item from an explicit instant and an epoch anchor, so a restart can recover the same schedule position without saved timers.
- The simulator writes one atomically replaced PNG per display ID. A failed write leaves the prior frame intact. If no playlist asset is available, the agent leaves the last output frame untouched.
- Playlist rotation is a local device concern. Do not apply the 60-second minimum screenshot capture interval to local rotation or device sync.

## Diagnosing playback

1. Check the startup config path and read the structured log for validation or cache-open errors.
2. Confirm that the config's asset paths resolve from the config file's directory, not the shell's working directory.
3. For a skipped image, check source readability, supported format, expected SHA-256, decoded dimensions, and cache capacity.
4. Check that the display references a known playlist and that at least one asset in that playlist was cached successfully.
5. Inspect `examples/agent/simulator/var/frames/<display-id>.png`; runtime files under `var/` are generated output, not source assets.
6. If cached playback fails after restart, inspect the persistent cache volume and look for digest mismatch or filesystem permission errors.

Run the two-display demo from the repository root:

```sh
cd agent
go run ./cmd/ribbonfish -config ../examples/agent/simulator/config.json
```

The example rotates `display-left` every 15 seconds and `display-right` every 9 seconds. It needs no network, Docker, or display hardware.

## Change and test guidance

- Add tests beside the package as `*_test.go`; cover both successful playback and failure behavior such as missing files, bad digests, cache exhaustion, and cancellation.
- For schedule changes, test exact boundaries and times before the anchor using explicit timestamps.
- For cache mutations, check that an interrupted or invalid write cannot replace a known-good asset and that protected playlist assets survive pruning.
- For simulator changes, verify that a failed frame write preserves the previous PNG and that display IDs remain isolated.
- Avoid changing the separate capture retention rules (10 captures or 30 days) when tuning the device cache.

See [Go Agent Development](../go-agent-development/SKILL.md) for package ownership and [Container Smoke Testing](../container-smoke-testing/SKILL.md) for the persistent-cache restart check.

For the separate Cloudflare asset lifecycle, see [Cloudflare Asset Lifecycle](../cloudflare-asset-lifecycle/SKILL.md).
