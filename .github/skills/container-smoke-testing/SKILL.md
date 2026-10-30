---
name: container-smoke-testing
description: Run and interpret Ribbonfish Go CI and Docker smoke checks for simulator behavior and ARM container compatibility.
tags: [ribbonfish, go, docker, ci, arm, testing]
relatedSkills: [go-agent-development, offline-playback-cache, raspberry-pi-deployment]
---

# Container Smoke Testing

Use this skill for changes to the Go build, `agent/Dockerfile`, simulator, container harness, CI workflows, or Raspberry Pi Compose examples.

## Checks in GitHub Actions

`.github/workflows/agent.yml` runs for every pull request and for `main` pushes affecting `agent/**` or the workflow. It checks Go formatting, `go vet`, `govulncheck`, unit tests with the race detector, and Linux ARMv7 and ARM64 cross-compilation.

`.github/workflows/arm-container-smoke.yml` runs for changes to the agent, simulator assets/config, Pi examples, or that workflow. It validates Pi Compose files and runs the `pi3b` ARMv7, `pi3a-plus` ARM64, and `pi4` ARM64 container profiles under QEMU.

## Run the smoke harness locally

From the repository root, with Docker Buildx available:

```sh
sh agent/scripts/smoke-container.sh linux/arm/v7 pi3b
sh agent/scripts/smoke-container.sh linux/arm64 pi3a-plus
sh agent/scripts/smoke-container.sh linux/arm64 pi4
```

The accepted pairs include `linux/arm/v7 pi3b`, `linux/arm64 pi3a-plus`, `linux/arm64 pi4`, and native `linux/amd64` simulator profiles. The native pair is a simulator/container check and does not establish ARM compatibility.

The harness builds the image, starts it with bundled sample PNGs, checks that each expected display writes a valid PNG and logs a frame update, stops the process cleanly, then restarts without source assets while retaining its cache volume. The Pi 4 simulator presents the same active playlist on both outputs. The harness removes its temporary container, volumes, and scratch directory on exit.

## What a pass establishes

- The Go image builds and starts for the requested container architecture.
- The local JSON config, mounted sample assets, cache writes, and simulator output work together in the container.
- The configured single- or dual-display simulator profile writes PNG frames; Pi 4 verifies both outputs use the shared active playlist.
- The process responds to container stop with a successful exit.
- The agent can use cached images after a restart with the source assets removed.

QEMU checks architecture/container compatibility. Native ARM64 on a Pi host additionally checks that host's Docker engine and kernel. Neither validates Raspberry Pi OS broadly, DRM permissions, DRM master ownership, KMS modesetting, HDMI scanout, hotplug, display timing, or physical dual-output behavior. Do not report simulator evidence as hardware acceptance.

## When checks fail

- Compose config failure: compare required substitutions and service fields with `examples/raspberry-pi/README.md` and `.env.example`.
- Build failure: check the Go toolchain in `agent/go.mod` and `agent/Dockerfile`, plus Buildx target platform/variant handling.
- No initial frame: inspect container logs, read-only config/assets mounts, config-relative paths, and output-volume permissions for UID 65532.
- Offline restart failure: make sure the cache volume is reused and the initial run completed before source assets were removed.
- ARM-only failure: reproduce the exact platform/profile pair and keep the report scoped to emulation or host compatibility unless a physical display was tested.

For local Go checks and package behavior, see [Go Agent Development](../go-agent-development/SKILL.md). For actual Pi deployment boundaries, see [Raspberry Pi Deployment](../raspberry-pi-deployment/SKILL.md).
