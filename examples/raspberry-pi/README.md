# Raspberry Pi deployment

This directory has two deployment modes. The simulator writes PNG frames without touching HDMI. The experimental hardware Compose service uses Linux DRM/KMS to present the same local playlists through one or more configured connectors. Pi 3 A+ KMS mode-setting, frame updates, and visible sample slides have been confirmed. Pi 3B and Pi 4 dual-display acceptance remain open.

## Files

- `docker-compose.simulator.yaml`: isolated software simulation with PNG frames and persistent volumes
- `simulator-config.json`: two logical simulator displays rendered at 1920x1080
- `simulator-config.pi3a-plus.json`: one simulator display matching the tested Pi 3 A+ connector and observed 1920x1080@60 mode
- `docker-compose.yaml`: local-file DRM/KMS deployment, using sample images and no control-plane connection
- `hardware-config.pi4.json`: two-display Pi 4 profile using HDMI-A-1 and HDMI-A-2
- `hardware-config.pi3a-plus.json`: tested one-display Pi 3 A+ profile using card0 and HDMI-A-1
- `hardware-config.pi3b.json`: one-display Pi 3B profile using HDMI-A-1
- `.env.example`: image tag, config path, cache path, DRM device, and numeric DRM group

The agent has no enrollment or remote synchronization yet. The hardware service therefore uses local config/assets and `network_mode: none`. The publishing workflow builds ARMv7 and ARM64 images when a `v*` Git tag is pushed. The version in `.env.example` is an example; set it to a published version.

The workflow publishes to GHCR but does not change package visibility. Make the package public in GitHub Packages for unauthenticated pulls, or sign in on the Pi with an account/token that can read the package before running `docker compose pull`.

## Software simulator on Agentlab

Agentlab is a Raspberry Pi 4 Model B Rev 1.5 running 64-bit Debian 13 (`aarch64`). During the last host inspection, it exposed `/dev/dri/card0` with `v3d` and `/dev/dri/card1` with `vc4-drm`; both HDMI connectors were disconnected. The simulator does not open the DRM devices, so it can run without an HDMI display.

From the repository root:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml config
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml logs -f agent
```

Frames are written to the `simulator-frames` volume. To copy them out:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-left.png ./display-left.png
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-right.png ./display-right.png
```

The simulator output size is a software fixture taken from `mode`; it does not query the monitor's advertised mode or emulate DRM, memory pressure, or a particular Raspberry Pi model. The Pi 3 A+ simulator profile captures the single connector and 1920x1080@60 timing observed during hardware acceptance. To run that profile:

```sh
RIBBONFISH_SIMULATOR_CONFIG=./simulator-config.pi3a-plus.json \
  docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
```

`fit` supports `contain` (black bars), `cover` (center crop), and `stretch` (change aspect ratio). The DRM backend selects a requested mode from the connector's advertised modes or uses its preferred mode.

## DRM/KMS setup

The Linux backend opens the configured DRM card, requests DRM master, selects the configured connector and mode, allocates two XRGB8888 dumb buffers per display, and uses legacy KMS modesetting plus page flips for later frames. It does not use X11 or Wayland. The host display server must release the selected card. When this service takes over the card, it controls scanout for the configured displays. On the tested Pi 3 A+, the framebuffer console resumed its original framebuffer after a clean stop; other kernels may behave differently.

The backend and its config/selection logic have automated tests and cross-compilation coverage. The following acceptance was run on `ribbonfish-01`, a Raspberry Pi 3 Model A Plus Rev 1.0 with Debian 13.7 ARM64, kernel `6.18.50+rpt-rpi-v8`, and Docker Engine 26.1.5:

- `/dev/dri/card0` is `root:video` (GID 44); HDMI-A-1 is connected and advertises 1920x1080@60.
- The 512 MiB Pi 3 A+ reports about 415 MiB total Linux memory in `free -h`.
- A non-root, read-only container with all capabilities dropped and no network started the `drm` backend, rotated the two-image playlist, and updated the active XRGB8888 framebuffer at 1920x1080.
- The agent process used about 26 MiB RSS; host available memory was about 195 MiB during the run. Temperature reached 43.5°C and `vcgencmd get_throttled` remained `0x0`.
- `docker stats` reported 0B/0B, and Docker discarded an attempted 128 MiB limit because this kernel does not provide usable memory-controller cgroups. Do not rely on Docker memory limits or `docker stats` for memory accounting on this host.
- The container exited cleanly. `kmsprint` then showed the original active 1920x1080 RGB16 framebuffer (FB 671), consistent with the framebuffer console resuming scanout.

SSH verified active KMS state and frame updates; the user also confirmed the bundled sample slides were visible on the monitor. This did not measure visual quality or scaling. Agentlab still has no connected HDMI monitor. Before another hardware acceptance run, inspect the target's device nodes, group IDs, connectors, and modes:

```sh
ls -l /dev/dri
stat -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

On Agentlab, the previous inspection found both card nodes owned by `root:video` (GID 44), with `vc4-drm` on card1. Recheck after reboot and on each different model/kernel. The tested Pi 3 A+ uses card0 and GID 44. Pi 3B uses `hardware-config.pi3b.json`; confirm its actual card and group before deploying.

From `examples/raspberry-pi`, prepare the Compose settings. For the tested Pi 3 A+, choose `./hardware-config.pi3a-plus.json`, `/dev/dri/card0`, and GID 44. For Pi 3B, choose `./hardware-config.pi3b.json` and confirm the actual DRM card/GID instead.

```sh
cp .env.example .env
# Edit .env: set a published RIBBONFISH_VERSION and confirm DRM device/GID.
docker compose config
docker compose run --rm agent -list-displays
docker compose pull
docker compose up -d
docker compose logs -f agent
```

The tested Pi has Docker Engine but no Compose plugin. For a Docker-only deployment, set `IMAGE` to a published agent image, then run:

```sh
docker volume create ribbonfish-cache
IMAGE=ghcr.io/cyanautomation/ribbonfish-agent:YOUR_PUBLISHED_VERSION
docker run --detach --name ribbonfish-agent --restart unless-stopped --stop-timeout 15 \
  --init --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 65532:65532 \
  --device /dev/dri/card0:/dev/dri/card0 --group-add 44 \
  --mount "type=bind,src=$PWD/hardware-config.pi3a-plus.json,dst=/etc/ribbonfish/config.json,readonly" \
  --mount "type=bind,src=$PWD/../agent/simulator/assets,dst=/assets,readonly" \
  --mount type=volume,src=ribbonfish-cache,dst=/var/lib/ribbonfish/cache \
  "$IMAGE" -config /etc/ribbonfish/config.json
```

Confirm the configured connector reports `connected`, startup selects the expected advertised mode, and the physical screen shows the bundled playlist image. On Pi 4, verify distinct content on both outputs. Restart the service and reboot the Pi to check mode selection, connector mapping, cache persistence, and recovery. Record results for both displays rather than treating a successful startup as proof of scanout. Stop the service with `docker compose down`.

`-list-displays` reads sysfs and reports connector metadata plus whether the mapped card node exists. It does not test permissions, DRM master acquisition, mode-setting, or actual pixels. A successful Compose config check or QEMU smoke run is not hardware acceptance either.

The Compose file maps only one DRM card, runs as UID 65532 with its numeric DRM group, drops all capabilities, uses a read-only root filesystem, and grants no network. It mounts the config and sample assets read-only and stores cache data in a named volume. Do not add `privileged: true` to work around a DRM permission or ownership failure; inspect the card owner, group, and active display services.

## Current hardware limitations

- Pi 3 A+ single-display KMS state, frame updates, and visible sample slides are confirmed. Pi 3B scanout and Pi 4 simultaneous dual-HDMI scanout still need direct testing.
- HDMI hotplug recovery is not implemented; a failed page flip faults that surface until restart.
- The agent does not save and restore the previous CRTC mode itself. The tested Pi 3 A+ framebuffer console resumed scanout after shutdown; this should be checked on each target kernel.
- Connector naming, mode availability, card numbering, and DRM master behavior can vary across kernel and boot settings.
- The service uses local bundled images only. There is no control-plane API, enrollment token, remote playlist sync, or network health check.
- Simulator PNGs and emulated ARM containers validate software/container behavior, not physical scanout, GPU timing, or thermal performance.
