---
name: raspberry-pi-deployment
description: Use Ribbonfish's simulator and experimental Linux DRM/KMS Raspberry Pi deployment without overstating unvalidated HDMI support.
tags: [ribbonfish, raspberry-pi, docker-compose, drm, deployment]
relatedSkills: [container-smoke-testing, offline-playback-cache, go-agent-development]
---

# Raspberry Pi Deployment

Use this skill for `examples/raspberry-pi/`, Pi host diagnostics, or questions about whether the agent is ready for a physical display.

## Separate simulation from physical scanout

- `docker-compose.simulator.yaml` is a software simulator for a native ARM64 Docker host. It has no network or DRM device access and writes PNGs to Docker volumes.
- `docker-compose.yaml` runs the local JSON configuration and bundled sample assets through the experimental DRM/KMS backend. It maps one selected `/dev/dri/cardN`, runs non-root with a read-only root filesystem and no added capabilities, and has no network because enrollment and remote synchronization are not implemented.
- `prepare-deployment.sh` stages the Compose file, hardware profiles, and assets together under `~/containers/ribbonfish`, creating `.env` on first setup and preserving local files on later runs.
- The agent supports connector/mode selection, image fitting, and XRGB8888 dumb-buffer scanout. Single-display 1920x1080 KMS state, frame updates, and visible sample slides have been confirmed on a Pi 3 Model A Plus; Pi 3B and Pi 4 dual-output scanout remain unverified.
- `.github/workflows/docker-publish.yml` publishes `cyanautomation/ribbonfish` to Docker Hub for AMD64, ARM64, and ARMv7 after a PR merges into `main`, using both `latest` and immutable merge-SHA tags. Use `latest` for convenience or a SHA tag to pin a deployment. `.github/workflows/publish-agent.yml` separately publishes ARMv7 and ARM64 release images to `ghcr.io/cyanautomation/ribbonfish` from `v*` tags. Verify example image versions and Pi device/group values on the target.

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

Treat each of these as a separate target-device check: Pi 3B output, simultaneous distinct frames on both Pi 4 HDMI outputs, connector identity across reboot, least-privilege DRM permissions, hotplug/recovery, offline restart, and sustained resource use. The Pi 3 A+ acceptance notes are in the Raspberry Pi README. A Compose config pass, sysfs listing, QEMU smoke test, or simulator PNG is not evidence that KMS scanout works.

For emulator/native container checks, use [Container Smoke Testing](../container-smoke-testing/SKILL.md). For the current Go runtime contract, use [Go Agent Development](../go-agent-development/SKILL.md).

## References

- [Raspberry Pi Compose README](../../../examples/raspberry-pi/README.md)
- [Hardware Compose template](../../../examples/raspberry-pi/docker-compose.yaml)
- [Simulator Compose file](../../../examples/raspberry-pi/docker-compose.simulator.yaml)
