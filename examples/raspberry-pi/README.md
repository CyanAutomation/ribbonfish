# Raspberry Pi Docker Compose proof of concept

This directory describes the **intended deployment contract** for Ribbonfish's lightweight Go display agent on Raspberry Pi OS Lite. It is a **template, not a working deployment**: the OCI image, environment variable interface, agent enrolment, DRM/KMS backend and multi-output behaviour are not yet implemented or validated.

## Files

- `docker-compose.yaml`: one headless agent service, no browser or desktop on the Pi
- `.env.example`: non-secret Compose substitution variables

## Prerequisites

- Raspberry Pi 3B or Raspberry Pi 4 running a compatible Raspberry Pi OS Lite installation
- Docker Engine with Docker Compose v2
- Available DRM/KMS device node(s) under `/dev/dri`
- An agent image built for the host architecture (ARMv7 for 32-bit Pi 3B; ARM64 if using a compatible 64-bit installation)
- A deployed Ribbonfish control plane and a provisioned device identity and token (both future work)

Check the local graphics devices and their permissions before editing the Compose mapping:

```sh
ls -l /dev/dri
stat -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

`/dev/dri/card0` and the numeric group ID in the example are **illustrative only**. Depending on the kernel, boot configuration and hardware, a different card node or additional nodes may be needed. In particular, **Pi 4 dual HDMI is not yet proven**, nor is DRM master ownership inside a container.

## Proposed setup (after the agent and control plane exist)

1. Copy `.env.example` to `.env`; set the actual published image version, API URL, device ID and group ID for the DRM card.
2. Create `secrets/device-token` using an enrolled, device-scoped credential. Restrict file permissions, do not commit it and do not put it in `.env`. **Note:** the current example uses a read-only bind mount, not a Docker Swarm secret.
3. Confirm the target DRM node in `docker-compose.yaml`; adjust mappings and permissions as needed for your Pi.
4. Once a compatible image exists, validate the interpolated configuration with `docker compose config`; then start with `docker compose up -d` and inspect `docker compose logs -f agent`.
5. Confirm local image display, clean restart, cache persistence and offline playback before testing multiple monitors.

Never supply Cloudflare API credentials, JEV secrets or screenshot-renderer credentials to this agent. Those belong in the Cloudflare control plane. Device-side cache persists independently of the credential file.

## Security and operational notes

- The image reference is hypothetical: pin an immutable release tag or image digest after images are published. Avoid `latest`.
- The device token is sensitive: protect it with filesystem permissions and provision/rotate it through the control plane. Do not commit `.env), tokens, screenshots or runtime state.
- The container intentionally does **not** use `privileged: true`, `network_mode: host`, a browser, X11 or Wayland. Add privileges only if hardware measurements show they are essential.
- `no-new-privileges` is useful hardening, but does not solve DRM permissions or master ownership.
- Named-volume caching allows restart and image updates without discarding downloaded screenshots. Define cache eviction and disk limits in the agent.
- No speculative `healthcheck` is included: add one once the Go agent exposes a real readiness/health contract.
- Any additional DRM node mapping or permissions should be validated separately on Pi 3B and Pi 4, including screen hotplug and dual-output operation.

## Hardware PoC acceptance checklist

- [ ] Pi 3B can display a local image with direct DRM/KMS from an unprivileged-as-practical container
- [ ] Pi 4 can show different images simultaneously on both HDMI connectors
- [ ] Display identity survives reboot and connector ordering changes
- [ ] Agent restarts and preserves cache; playback continues through control-plane/network outages
- [ ] Permissions, DRM master ownership and any required device-node mappings are documented
- [ ] Actual resource use (RAM, CPU), image switch latency and display stability are measured

The Cloudflare capture scheduler, queue, Browser Run integration, R2 screenshots and optional JEV optimiser run **outside this Compose deployment**.
