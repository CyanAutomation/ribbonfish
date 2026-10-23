# Ribbonfish agent foundation

This directory contains the hardware-independent Go agent. It defines a
versioned local JSON contract, structured logging, cancellation-aware process
lifecycle, deterministic per-display playlist scheduling, and a persistent
content-verified image cache. Display output and synchronization remain
replaceable interfaces.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
For a native ARM64 Docker host such as Agentlab, see the Pi simulator Compose
example in [`../examples/raspberry-pi/README.md`](../examples/raspberry-pi/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions. The simulator is a software backend; it is
not evidence of physical display support.

On Linux, `ribbonfish -list-displays` reports DRM connectors from sysfs,
including the owning `/dev/dri/cardN`, driver, connector status, and modes. It
does not open the device or test modesetting, permissions, or scanout. Use it
to check host discovery only; physical output remains unimplemented.

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
sh agent/scripts/smoke-container.sh linux/amd64 pi4
```

The native check exercises the container and dual-output simulator profile,
but does not check ARM compatibility. On Agentlab, run the ARM64 profile to
exercise the Pi's native Docker Engine and kernel without a connected monitor;
the check only writes PNG files and does not access DRM.

GitHub Actions runs both checks on changes to the agent, simulator, or Pi
examples, and validates both Raspberry Pi Compose files. Pushing a
`vMAJOR.MINOR.PATCH` tag publishes `ghcr.io/cyanautomation/ribbonfish-agent:<tag>`
for ARMv7 and ARM64. The image is a software compatibility artifact; it does
not implement the proposed hardware environment interface or physical display
output. Pi acceptance remains separate work.
