# Ribbonfish agent foundation

This directory contains the Go display agent. It defines a versioned local
JSON contract, bundled Pi and simulator profiles, structured logging,
cancellation-aware lifecycle, deterministic shared-playlist scheduling, a
persistent content-verified image cache, and optional authenticated playlist
sync. It includes a PNG simulator and an experimental Linux DRM/KMS output
backend.

The container image includes `defaults/` and its starter images. The default
profile is `pi4`; select `pi3b`, `pi3a-plus`, `simulator`,
`simulator-pi3a-plus`, `simulator-pi3b`, or `simulator-pi4` with
`RIBBONFISH_PROFILE`. `RIBBONFISH_CONFIG_FILE` can still point to a local
override.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
For a native ARM64 Raspberry Pi such as Ribbonfish, see the Pi simulator Compose
example in [`../examples/raspberry-pi/README.md`](../examples/raspberry-pi/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions, and
[`../workers/device-sync/README.md`](../workers/device-sync/README.md) for
Worker deployment, global playlist publishing, and per-device enrollment. The
DRM backend uses named DRM connectors, the connector's preferred or requested
mode, linear XRGB8888 dumb buffers, and page flips. It requires exclusive DRM
master access to the chosen card and may take over scanout from a host display
server.

On Linux, `ribbonfish -list-displays` reports DRM connectors from sysfs,
including the owning `/dev/dri/cardN`, whether that device node exists, driver,
connector status, and modes. It does not open the device or test modesetting,
permissions, or scanout. `ribbonfish -check-displays` compares the configured
DRM card, connectors, and requested resolutions with that sysfs information.
It is also read-only and does not acquire DRM master or change display state;
the actual DRM backend must still be tested on hardware.

On Raspberry Pi 4, card numbering can differ between devices because the V3D
render driver and VC4 KMS display driver may probe in a different order. The
Pi deployment guide uses `/dev/dri/by-path/platform-gpu-card` to select the KMS
device and explains how to inspect its target and group. The preflight check
matches that alias to the connector's sysfs card by Linux device number, so it
does not depend on the host and container using the same `/dev/dri/cardN`
spelling. Physical dual-HDMI scanout still requires acceptance on the target
hardware.

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
the ARMv7 single-display Pi 3B profile, the ARM64 single-display Pi 3 A+ profile,
and the ARM64 two-display Pi 4 profile. It does not emulate Raspberry Pi OS,
DRM/KMS, GPIO, display timing, or physical connector behavior.

With Docker Buildx and QEMU/binfmt support installed, run either profile from
the repository root:

```sh
sh agent/scripts/smoke-container.sh linux/arm/v7 pi3b
sh agent/scripts/smoke-container.sh linux/arm64 pi3a-plus
sh agent/scripts/smoke-container.sh linux/arm64 pi4
```

For a host-native container smoke check that does not require QEMU, use:

```sh
sh agent/scripts/smoke-container.sh linux/amd64 pi3b
sh agent/scripts/smoke-container.sh linux/amd64 pi3a-plus
sh agent/scripts/smoke-container.sh linux/amd64 pi4
```

The native checks exercise single- and dual-output simulator profiles, but do
not check ARM compatibility. On Ribbonfish, run the ARM64 Pi 3 A+ profile to
exercise the actual Pi's Docker Engine and kernel. It writes PNG files in an
isolated container and does not open DRM or disturb the active HDMI output.

GitHub Actions runs both checks on changes to the agent, simulator, or Pi
examples, validates the Pi configs and Compose files, tests the device sync
Worker separately, and publishes images on protected `main` pushes that
change `agent/**`. GHCR receives ARMv7 and ARM64 images tagged `main` and with
the full commit SHA (`sha-<commit-SHA>`); Docker Hub receives AMD64, ARM64, and
ARMv7 images tagged with the full commit SHA. Docker Hub's `latest` tag moves
only when that commit is still the `main` tip. Use the immutable SHA tag to pin
a deployment. The published-image
simulator Compose example is in
`examples/raspberry-pi/docker-compose.published.yaml`. The hardware Compose
example starts from bundled local content with no network by default. Optional
sync requires an explicit bridge network, Worker URL, and device ID. If no
legacy token exists, the agent creates a persistent Ed25519 identity, displays
its fingerprint, and waits for approval in the management console before it
starts syncing. The private key is stored in the state volume with mode 0600.
Older devices can continue using a one-time code through `-enroll`. Single-display 1080p KMS mode-setting and frame updates have been
verified over SSH on a Pi 3 Model A Plus, and the user confirmed the sample
slides were visible. Pi 3B and Pi 4 dual-display behavior still need physical
acceptance. Emulated tests do not prove KMS scanout.

The agent logs the first successful unchanged sync poll after startup or a
sync failure with its ETag. Further unchanged polls stay quiet until the next
failure; a changed, verified playlist is logged when it is activated.

When `RIBBONFISH_SYNC_URL` and a valid device credential are configured, the
agent also posts an authenticated health report to `/v1/telemetry`. It reports
its process version and uptime, content-sync outcome and applied revision,
configured display/connector status and age of the last successful frame, plus
available host metrics: Linux uptime, one-minute load, available memory, free
space on the state volume, and CPU temperature when the kernel exposes it.
Reports are sent at startup, on health transitions, every minute, and best
effort at shutdown. They contain stable error codes rather than logs or raw
error messages. Reporting uses the existing bearer token or approved Ed25519
device key and is bounded to 8 KiB per report.
