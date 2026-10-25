# Go agent foundation

## Architecture

The Go module lives under `agent/`, matching the proposed repository boundary
in the project README. Its small packages define contracts rather than
depending on Cloudflare or Linux graphics libraries:

- `internal/config` owns the versioned local JSON contract and validation.
- `internal/agent` composes the offline cache, playlist runner, and output.
- `internal/display` accepts decoded frames through one output interface.
- `internal/display/simulator` writes one atomic PNG per logical display,
  optionally resized to the configured output mode.
- `internal/display/drm` configures Linux DRM/KMS connectors and scans out
  images using XRGB8888 dumb buffers and page flips.
- `internal/cache` implements verified, bounded persistent image storage.
- `internal/playlist` schedules deterministic per-display rotation.
- `internal/syncer` is the replaceable synchronization boundary.
- `internal/logging` configures standard-library `log/slog`.

The current CLI loads and validates configuration, emits structured startup
and shutdown records, and exits cleanly on SIGINT or SIGTERM. The local runtime
loads images into the cache and rotates each configured display independently.
It can write mode-sized PNG frames through the software simulator or present
them through an experimental Linux DRM/KMS backend. The module has no
third-party dependencies.

## Local configuration contract

The config format is strict JSON, version 1. It describes a bounded cache,
simulator or DRM output, image fitting, ordered playlist assets, and a playlist
plus rotation interval for each logical display. DRM outputs map logical IDs
to connector names and preferred or explicit modes. Relative paths are
anchored to the config file, so the same config works when launched from
another working directory. Unknown fields and invalid references fail at startup.
At startup, source files are checked and valid images are cached. Each frame
is verified again when loaded for presentation, so one missing or corrupt
asset does not make other displays or assets unavailable.

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

If the cache directory cannot be created or opened, the agent reports a
startup error. If an individual asset cannot be read, decoded, integrity
checked, or stored because the cache is full, that item is skipped; displays
continue with other verified cached items and preserve their last written
frame when no valid item remains.

## Raspberry Pi deployment

`examples/raspberry-pi/docker-compose.simulator.yaml` runs the software
simulator with no network or DRM access. `docker-compose.yaml` runs the DRM
backend using local JSON config and bundled assets, maps one DRM card, mounts a
persistent cache, and runs non-root with a read-only root filesystem and no
added capabilities. It intentionally has no network because control-plane
enrollment and synchronization are not implemented. `.env.example` shows the
Agentlab Pi 4 device path/group; verify those values per host. The publishing
workflow creates ARMv7/ARM64 images from `v*` tags.

DRM output has passed a single-display KMS mode-setting and frame-update check
over SSH on a Pi 3 Model A Plus, and the user confirmed that the sample slides
were visible on the monitor. The host display manager must release the selected
DRM card. A Compose config check, sysfs discovery, QEMU smoke test, or simulator
PNG does not prove modesetting or scanout.

## Assumptions and unresolved hardware questions

- PNG, JPEG, and GIF are the initial image formats supported by the
  standard-library decoders.
- Both backends consume the same decoded `image.Image` frame interface.
- Display IDs are stable logical names from local configuration; connector
  names map them to DRM outputs. Connector identity and ordering across reboot
  still need target testing.
- Single-display 1920x1080 KMS state, frame updates, visible sample slides, and
  least-privilege DRM access were verified on a Pi 3 Model A Plus. Pi 3B, Pi 4
  dual-output, hotplug recovery, and cross-kernel DRM ownership behavior remain
  unverified.
- Cache capacity defaults, filesystem durability across power loss, and
  practical image-size limits need device measurements before production
  deployment.

Cross-compilation checks architecture support only. It is not evidence of
Raspberry Pi hardware compatibility.
