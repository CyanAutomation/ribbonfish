# Ribbonfish agent foundation

This directory contains the Go display agent. It defines a versioned local
JSON contract, bundled Pi and simulator profiles, structured logging,
cancellation-aware lifecycle, deterministic per-display scheduling, a
persistent content-verified image cache, and optional authenticated manifest
sync. It includes a PNG simulator and an experimental Linux DRM/KMS output
backend.

The container image includes `defaults/` and its starter images. The default
profile is `pi4`; select `pi3b`, `pi3a-plus`, `simulator`, `simulator-pi3b`, or
`simulator-pi4` with `RIBBONFISH_PROFILE`. `RIBBONFISH_CONFIG_FILE` can still
point to a local override.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
For a native ARM64 Docker host such as Agentlab, see the Pi simulator Compose
example in [`../examples/raspberry-pi/README.md`](../examples/raspberry-pi/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions, and
[`../workers/device-sync/README.md`](../workers/device-sync/README.md) for
Worker deployment and per-device enrollment. The DRM backend uses named DRM connectors,
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
container build, bundled default configuration and assets, fresh named-volume
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
examples, validates the Pi configs and Compose files, tests the device sync
Worker separately, and publishes an ARMv7/
ARM64 release image to GHCR when a `v*` tag is pushed. A separate workflow
publishes `cyanautomation/ribbonfish` to Docker Hub for AMD64, ARM64, and
ARMv7 after PRs merge into `main`, tagged as both `latest` and the full
merge SHA (`sha-<merge-commit-SHA>`). Use the immutable SHA tag to pin a
deployment; `latest` moves after verification passes. The published-image
simulator Compose example is in
`examples/raspberry-pi/docker-compose.published.yaml`. The hardware Compose
example starts from bundled local content with no network by default. Optional
sync requires an explicit bridge network, Worker URL, device ID, and a token
provisioned with `-enroll`; the random device token is stored in the persistent
state volume with mode 0600. Single-display 1080p KMS mode-setting and frame updates have been
verified over SSH on a Pi 3 Model A Plus, and the user confirmed the sample
slides were visible. Pi 3B and Pi 4 dual-display behavior still need physical
acceptance. Emulated tests and the Agentlab simulator do not prove KMS scanout.
