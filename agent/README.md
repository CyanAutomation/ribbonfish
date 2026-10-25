# Ribbonfish agent foundation

This directory contains the Go display agent. It defines a versioned local
JSON contract, structured logging, cancellation-aware process lifecycle,
deterministic per-display playlist scheduling, and a persistent
content-verified image cache. It includes a PNG simulator and an experimental
Linux DRM/KMS output backend.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
For a native ARM64 Docker host such as Agentlab, see the Pi simulator Compose
example in [`../examples/raspberry-pi/README.md`](../examples/raspberry-pi/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions. The DRM backend uses named DRM connectors,
the connector's preferred or requested mode, linear XRGB8888 dumb buffers, and
page flips. It requires exclusive DRM master access to the chosen card and
may take over scanout from a host display server.

On Linux, `ribbonfish -list-displays` reports DRM connectors from sysfs,
including the owning `/dev/dri/cardN`, whether that device node exists, driver,
connector status, and modes. It does not open the device or test modesetting,
permissions, or scanout. Use it to select a card and connector before testing
the actual DRM backend.

Build and test the module with:

```sh
go test ./...
go build ./cmd/ribbonfish
```

Run the software demo using the instructions linked above.

## ARM container compatibility

The simulator can also run inside ARM containers under QEMU. This checks the
container build, startup configuration, local asset loading, fresh named-volume
writes, graceful shutdown, and offline restart from the persistent cache for
the ARMv7 single-display (Pi 3B) and ARM64 two-display (Pi 4) profiles. It does
not emulate Raspberry Pi OS, DRM/KMS, GPIO, display timing, or physical
connector behavior.

With Docker Buildx and QEMU/binfmt support installed, run either profile from
the repository root:

```sh
sh agent/scripts/smoke-container.sh linux/arm/v7 pi3b
sh agent/scripts/smoke-container.sh linux/arm64 pi4
```

For a host-native container smoke check that does not require QEMU, use:

```sh
sh agent/scripts/smoke-container.sh linux/amd64 pi3b
sh agent/scripts/smoke-container.sh linux/amd64 pi4
```

The native checks exercise both single- and dual-output simulator profiles,
but do not check ARM compatibility. On Agentlab, run the ARM64 profile to
exercise the Pi's native Docker Engine and kernel without a connected monitor;
the check only writes PNG files and does not access DRM.

GitHub Actions runs both checks on changes to the agent, simulator, or Pi
examples, validates the Pi configs and Compose files, and publishes an ARMv7/
ARM64 release image to GHCR when a `v*` tag is pushed. A separate workflow
publishes `cyanautomation/ribbonfish` to Docker Hub for AMD64, ARM64, and
ARMv7 after PRs merge into `main`, tagged as both `latest` and the full
merge SHA (`sha-<merge-commit-SHA>`). Use the immutable SHA tag to pin a
deployment; `latest` moves after verification passes. The published-image
simulator Compose example is in
`examples/raspberry-pi/docker-compose.published.yaml`. The hardware Compose
example runs the bundled local image playlists with no network or control
plane. Single-display 1080p KMS mode-setting and frame updates have been
verified over SSH on a Pi 3 Model A Plus, and the user confirmed the sample
slides were visible. Pi 3B and Pi 4 dual-display behavior still need physical
acceptance. Emulated tests and the Agentlab simulator do not prove KMS scanout.
