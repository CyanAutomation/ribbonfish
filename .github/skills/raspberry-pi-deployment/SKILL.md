---
name: raspberry-pi-deployment
description: Use the working simulator Compose setup and review Ribbonfish's future Raspberry Pi hardware template without overstating device support.
tags: [ribbonfish, raspberry-pi, docker-compose, drm, deployment]
relatedSkills: [container-smoke-testing, offline-playback-cache, go-agent-development]
---

# Raspberry Pi Deployment

Use this skill for `examples/raspberry-pi/`, Pi host diagnostics, or questions about whether the agent is ready for a physical display.

## Separate the simulator from the hardware template

- `docker-compose.simulator.yaml` is a software simulator for a native ARM64 Docker host. It has no network or DRM device access and writes PNGs to Docker volumes.
- `docker-compose.yaml` is a future hardware proof-of-concept template. Its API/device/token environment variables are proposed and are not read by the current Go agent. Agent enrollment and DRM/KMS presentation are not implemented.
- This repository does not automatically publish an OCI image. GitHub releases and version tags are managed manually; a compatible image must be made available separately before the hardware template can run.

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

DRM card numbering and group ownership can vary by host. Keep device mappings narrow, use the actual DRM device/group, and do not add `privileged: true` as a shortcut. The current template uses UID 65532 and supplementary groups; its token bind mount is read-only. Follow the Raspberry Pi README's dedicated token-group and `0440` guidance instead of making a token world-readable or owner-only when the container must read it.

Never give device containers Cloudflare API, Browser Run, or JEV credentials. Keep `.env`, device tokens, screenshots, and runtime output out of Git. `no-new-privileges` and a read-only token mount do not prove DRM access or DRM master ownership.

## Hardware acceptance evidence

Treat each of these as a separate target-device check: Pi 3B output, simultaneous distinct frames on both Pi 4 HDMI outputs, connector identity across reboot, least-privilege DRM permissions, hotplug/recovery, offline restart, and sustained resource use. A Compose config pass, sysfs listing, QEMU smoke test, or simulator PNG is not evidence that KMS scanout works.

For emulator/native container checks, use [Container Smoke Testing](../container-smoke-testing/SKILL.md). For the current Go runtime contract, use [Go Agent Development](../go-agent-development/SKILL.md).

## References

- [Raspberry Pi Compose README](../../../examples/raspberry-pi/README.md)
- [Hardware Compose template](../../../examples/raspberry-pi/docker-compose.yaml)
- [Simulator Compose file](../../../examples/raspberry-pi/docker-compose.simulator.yaml)
