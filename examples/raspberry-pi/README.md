# Raspberry Pi Docker Compose proof of concept

This directory contains a runnable ARM64 software simulator Compose file and a separate **future hardware deployment template**. GitHub Releases and version tags are managed manually through the GitHub UI; this repository does not automatically publish OCI images. The hardware template requires a compatible image to be made available separately and is not a working deployment: its environment-variable interface, agent enrollment, DRM/KMS output, and multi-output behavior remain future work.

## Current agent contract

The local Go agent accepts a versioned JSON file through `ribbonfish -config <path>`, uses a persistent filesystem cache, and writes simulated frames as PNG files. It does not yet read the proposed `RIBBONFISH_API_URL`, `RIBBONFISH_DEVICE_ID`, `RIBBONFISH_TOKEN_FILE`, or `RIBBONFISH_CACHE_DIR` variables, enroll with a control plane, or present frames through `/dev/dri`.

Files:

- `docker-compose.simulator.yaml`: builds and runs the two-output PNG simulator on a native ARM64 Docker host
- `simulator-config.json`: local simulator configuration for that Compose file
- `docker-compose.yaml`: future hardware deployment template
- `.env.example`: non-secret hardware Compose substitutions

## Run the simulator natively on Agentlab

Agentlab is a Raspberry Pi 4 Model B Rev 1.5 running 64-bit Debian 13 (`aarch64`) with kernel `6.18.29+rpt-rpi-v8`, Docker Engine 29.6.0, and Compose 5.1.4. The simulator Compose file explicitly builds/runs `linux/arm64`, keeps the process at UID 65532, persists cache and frame data in Docker-managed volumes, and has no network or DRM device access.

From a checkout on Agentlab, run these commands from the repository root:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml config
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml logs -f agent
```

While the service is running, inspect the host's DRM connector metadata with `docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml exec agent /ribbonfish -list-displays`. This reads sysfs only and does not open or change a DRM device.

The PNGs live in the `simulator-frames` volume. Copy them to the host with `docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-left.png ./display-left.png` and the corresponding command for `display-right.png`. Stop the service with `docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml down`.

To observe host resource use while it runs, use `docker stats "$(docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml ps -q agent)"`. For longer runs, record idle and active CPU/RAM, cache volume growth (`docker system df -v`), and Pi temperature (`vcgencmd measure_temp` when available). These measurements cover the simulator workload, not HDMI scanout or display-related GPU use.

The native host smoke check can also run without Compose:

```sh
sh agent/scripts/smoke-container.sh linux/arm64 pi4
```

It builds and runs the ARM64 image, checks fresh named-volume writes and graceful stop, then restarts without the source assets to prove cache persistence and offline startup. GitHub Actions runs ARMv7 and ARM64 variants under QEMU; only the manual run on Agentlab exercises the Pi kernel and its Docker installation. Neither path proves physical display output.

The read-only connector inventory command reports which card owns each connector and the sysfs-reported driver, connection state, and modes; it does not attempt to open the card or change display state.

## Agentlab DRM baseline

Agentlab exposes `/dev/dri/card0` with the `v3d` driver and `/dev/dri/card1` with `vc4-drm`. Its HDMI connectors appear as `card1-HDMI-A-1` and `card1-HDMI-A-2`; both were disconnected during the last inspection. Both card nodes are owned by `root:video` (GID 44); `/dev/dri/renderD128` is owned by `root:render` (GID 992). The hardware template defaults to `/dev/dri/card1` and GID 44 for this host. Recheck the actual nodes and groups on every target because numbering can vary with the kernel and boot configuration.

This identifies the display-capable DRM device on Agentlab; it does not prove that a container can take DRM master or present a frame. Connector mapping, hotplug behavior, Pi 4 dual-HDMI output, and simultaneous scanout remain hardware acceptance items for the phase when a monitor is available.

## Future hardware setup

Prerequisites are a compatible Raspberry Pi OS Lite installation, Docker Compose, the actual DRM node and group IDs, a compatible agent image made available for the host architecture, and a provisioned device identity/token. Before editing the hardware Compose mapping, inspect:

```sh
ls -l /dev/dri
stat -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

Copy `.env.example` to `.env` and set the actual image version, API URL, device ID, DRM device path and GID. For the sensitive token file, create a dedicated host group named `ribbonfish-token`, put its numeric GID in `RIBBONFISH_TOKEN_GID`, then create `secrets/device-token` owned by `root:ribbonfish-token` with mode `0440`. For example: `sudo install -o root -g ribbonfish-token -m 0440 /dev/null ./secrets/device-token`; populate it only through the approved enrollment flow. The container runs as UID 65532 and receives this group as a supplementary group, so an owner-only `0600` token file would not be readable. The example is a read-only bind mount, not a Docker Swarm secret.

Never supply Cloudflare API credentials, JEV secrets, or screenshot-renderer credentials to the device agent. Keep `.env`, tokens, screenshots, and runtime files out of Git. The container does not use `privileged: true`, host networking, a browser, X11, or Wayland. `no-new-privileges` does not grant DRM permissions or DRM master ownership. Named-volume cache writes are prepared for the non-root image, but hardware output still needs validation. No health check is defined until the agent exposes a readiness contract.

## Hardware acceptance checklist

- [ ] Pi 3B displays a local image through DRM/KMS from an unprivileged container
- [ ] Pi 4 shows different images simultaneously on both HDMI connectors
- [ ] Display identity survives reboot and connector ordering changes
- [ ] Agent restarts and preserves its cache; playback survives control-plane/network outages
- [ ] DRM permissions, master ownership, hotplug, and node mappings are documented
- [ ] RAM, CPU, storage growth, image-switch latency, temperature, and display stability are measured during sustained playback

The Cloudflare capture scheduler, queues, Browser Run integration, R2 screenshots, and optional JEV optimizer run outside this Compose deployment.
