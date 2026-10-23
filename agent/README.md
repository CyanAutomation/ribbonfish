# Ribbonfish agent foundation

This directory contains the hardware-independent Go agent. It defines a
versioned local JSON contract, structured logging, cancellation-aware process
lifecycle, deterministic per-display playlist scheduling, and a persistent
content-verified image cache. Display output and synchronization remain
replaceable interfaces.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions. The simulator is a software backend; it is
not evidence of physical display support.

Build and test the module with:

```sh
go test ./...
go build ./cmd/ribbonfish
```

Run the software demo using the instructions linked above.

## ARM container compatibility

The simulator can also run inside ARM containers under QEMU. This checks the
container build, startup configuration, local asset loading, cache writes, and
PNG frame output for the ARMv7 single-display (Pi 3B) and ARM64 two-display
(Pi 4) profiles. It does not emulate Raspberry Pi OS, DRM/KMS, GPIO, display
timing, or physical connector behavior.

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
but does not check ARM compatibility.

GitHub Actions runs both checks on changes to the agent and simulator example.
The container is a local compatibility artifact; release publishing and
physical Pi acceptance remain separate work.
