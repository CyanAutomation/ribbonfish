---
name: raspberry-pi-deployment
description: Deploy Ribbonfish's simulator or experimental Linux DRM/KMS Raspberry Pi agent while distinguishing verified hardware from untested profiles.
tags: [ribbonfish, raspberry-pi, docker-compose, drm, deployment]
relatedSkills: [container-smoke-testing, offline-playback-cache, go-agent-development]
---

# Raspberry Pi Deployment

Use this skill for `examples/raspberry-pi/`, Pi host diagnostics, or questions about whether the agent is ready for a physical display.

## Separate simulation from physical scanout

- `docker-compose.simulator.yaml` is a software simulator for a native ARM64 Docker host. It has no network or DRM device access and writes PNGs to Docker volumes.
- `docker-compose.yaml` runs the bundled profile and sample assets through the experimental DRM/KMS backend. It maps one selected `/dev/dri/cardN`, runs non-root with a read-only root filesystem and no added capabilities, and defaults to `network_mode: none`. Set `RIBBONFISH_NETWORK_MODE=bridge` only when configuring optional authenticated Worker sync; the named state volume retains cached assets, the last-good playlist, and the device credential.
- `prepare-deployment.sh` stages the Compose file, hardware profiles, and assets together under `~/containers/ribbonfish`, creating `.env` on first setup and preserving local files on later runs.
- The agent supports connector/mode selection, image fitting, and XRGB8888 dumb-buffer scanout. Single-display KMS mode-setting, frame updates, and visible sample slides have been confirmed on a Pi 3 Model A Plus; Pi 3B and Pi 4 dual-output scanout remain unverified.
- Protected `main` pushes that change `agent/**` publish `cyanautomation/ribbonfish` to Docker Hub for AMD64, ARM64, and ARMv7 with an immutable commit-SHA tag; `latest` moves only when that commit is still the `main` tip. The same changes publish ARMv7 and ARM64 images to `ghcr.io/cyanautomation/ribbonfish` with `main` and immutable commit-SHA tags. Use `latest` for convenience or a SHA tag to pin a deployment. Verify example image versions and Pi device/group values on the target.

Run the simulator from the repository root:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml config
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml logs -f agent
```

The simulator's read-only connector report is:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml exec agent /ribbonfish -list-displays
```

It reads `/sys/class/drm` metadata. It does not open a DRM card, request DRM master, set a mode, or display a frame.

## Review hardware settings safely

On the target host, inspect device paths and numeric group IDs before setting Compose variables:

```sh
ls -l /dev/dri
stat -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

DRM card numbering and group ownership can vary by host. Keep device mappings narrow, use the actual DRM device/group, and do not add `privileged: true` as a shortcut. The deployment uses UID 65532 and a supplementary DRM group. The selected card must be free of another DRM master such as a display server.

Never give device containers Cloudflare API, Browser Run, or JEV credentials. Keep `.env`, screenshots, and runtime output out of Git. `no-new-privileges`, a Compose config pass, sysfs discovery, QEMU, and simulator PNG output do not prove DRM access or DRM master ownership.

## Hardware acceptance evidence

Treat each of these as a separate target-device check: Pi 3B output, simultaneous output on both Pi 4 HDMI connectors, and distinct images on each connector if validating the repository's dual-output product goal; connector identity across reboot; least-privilege DRM permissions; hotplug/recovery; offline restart; and sustained resource use. The current Pi 4 simulator intentionally verifies that both outputs show the same shared active playlist, not distinct images. The Pi 3 A+ acceptance notes are in the Raspberry Pi README. A Compose config pass, sysfs listing, QEMU smoke test, or simulator PNG is not evidence that KMS scanout works.

For a reproducible hardware report, record:

- Pi model/revision, OS image, kernel, container runtime, and Ribbonfish image digest.
- DRM card path and numeric group ID; selected connector names and advertised/requested modes.
- Whether another process held DRM master, the exact permissions used, and whether the container ran without privileged mode.
- For each output: monitor identity, resolution, observed image, and whether outputs changed independently or shared a playlist as configured.
- Results for reboot, hotplug, monitor sleep/wake, network loss, offline restart, and sustained runtime; include relevant structured logs without credentials.

For emulator/native container checks, use [Container Smoke Testing](../container-smoke-testing/SKILL.md). For the current Go runtime contract, use [Go Agent Development](../go-agent-development/SKILL.md).

## References

- [Raspberry Pi Compose README](../../../examples/raspberry-pi/README.md)
- [Hardware Compose template](../../../examples/raspberry-pi/docker-compose.yaml)
- [Simulator Compose file](../../../examples/raspberry-pi/docker-compose.simulator.yaml)
