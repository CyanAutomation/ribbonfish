# Go agent foundation

## Architecture

The Go module lives under `agent/`, matching the proposed repository boundary
in the project README. Its small packages define contracts rather than
depending on Cloudflare or Linux graphics libraries:

- `internal/config` owns the versioned local JSON contract and validation.
- `internal/agent` is the future composition point for the runtime adapters.
- `internal/display` accepts decoded frames through one output interface.
- `internal/cache` describes verified persistent image storage.
- `internal/playlist` describes deterministic per-display scheduling.
- `internal/syncer` is the replaceable synchronization boundary.
- `internal/logging` configures standard-library `log/slog`.

The current CLI loads and validates configuration, emits structured startup
and shutdown records, and exits cleanly on SIGINT or SIGTERM. Subsequent
implementation layers add local playback and the software display backend.
The module has no third-party dependencies.

## Local configuration contract

The initial config format is strict JSON, version 1. It describes a bounded
cache, simulator output directory, ordered playlist assets, and a playlist
plus rotation interval for each logical display. Relative paths are anchored
to the config file, so the same config works when launched from another
working directory. Unknown fields and invalid references fail at startup.
Asset files are checked at playback time so one missing asset does not make
other displays or assets unavailable.

Playlist timing is a local device concern and is independent of Cloudflare's
minimum 60-second screenshot capture interval. The scheduler receives wall
clock instants explicitly and uses deterministic schedule anchors, allowing
it to recover a stable position after restart without remote connectivity or
persisted timer state.

## Cache behavior

The device cache is separate from Cloudflare R2 screenshot retention. It is
bounded by a local byte limit. Content is keyed by SHA-256, writes use a
temporary file and atomic rename, and assets referenced by configured
playlists are protected from eviction. If all unprotected assets have been
evicted and the cache still cannot fit a required asset, the write fails
explicitly while existing cached content remains available.

## Compose review

The Raspberry Pi Compose file from PR #4 is a hardware deployment template,
not a supported interface for this local agent. It proposes API URL, device
identity, token-file, cache-directory, and `/dev/dri` settings. The current
foundation does not enroll with a control plane, read those environment
variables, or implement DRM/KMS. The template already labels those values as
proposed and says that the image is hypothetical. It must remain clearly
separate from the local simulator instructions until remote synchronization
and a hardware backend are implemented and validated.

## Assumptions and unresolved hardware questions

- PNG, JPEG, and GIF are the initial image formats supported by the
  standard-library decoders.
- The software simulator writes PNG output; physical output backends consume
  the same decoded `image.Image` frame interface.
- Display IDs are stable logical names from local configuration. Mapping them
  to physical connectors is deferred until device behavior is measured.
- DRM/KMS library choice, connector identity across reboot, scaling and
  rotation behavior, DRM master ownership, container permissions, and Pi 4
  dual-HDMI operation remain unverified hardware questions.
- Cache capacity defaults, filesystem durability across power loss, and
  practical image-size limits need device measurements before production
  deployment.

Cross-compilation checks architecture support only. It is not evidence of
Raspberry Pi hardware compatibility.
