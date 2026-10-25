# Raspberry Pi deployment

Ribbonfish ships a default profile and starter images inside the container.
The Compose deployment can run with networking disabled and does not need a
host-mounted config or asset directory. Once the image is on the Pi, the local
playlist works offline. Optional authenticated sync can replace its content
from a Cloudflare Worker backed by R2; it keeps using the last valid snapshot
when the Worker cannot be reached.

The DRM/KMS output is experimental. One-display mode-setting, frame updates,
and visible sample slides have been confirmed on a Pi 3 A+. Pi 3B scanout and
Pi 4 dual-display acceptance remain open.

## Files

- `docker-compose.yaml`: hardware deployment using a bundled profile and one
  persistent state volume
- `docker-compose.simulator.yaml`: source-built software simulation
- `docker-compose.published.yaml`: published-image simulation
- `.env.example`: image tag, profile, DRM device/group, and optional sync
  settings
- `prepare-deployment.sh`: detects the Pi profile and DRM group, pins the
  published image, and stages the complete deployment kit under
  `~/containers/ribbonfish`
- `verify-deployment.sh`: checks configuration before start and confirms the
  running container has displayed a frame
- `assets/` and `hardware-config.*.json`: source examples; the container
  profiles and starter images are bundled from `agent/defaults/`

## Install and start

From a clean, verified repository checkout on the Pi, stage the deployment
files:

```sh
sh examples/raspberry-pi/prepare-deployment.sh
cd ~/containers/ribbonfish
./verify-deployment.sh --preflight
docker compose -p ribbonfish pull
docker compose -p ribbonfish up -d
./verify-deployment.sh
```

The script detects Pi 3 A+, Pi 3 B, or Pi 4, reads the numeric group from the
selected DRM card, and writes an immutable `sha-<commit>` image pin into `.env`.
It starts in offline mode (`network_mode: none`). The generated environment is
mode `0600`; existing `.env` files are preserved by default. To replace a
legacy `.env`, the script makes a private timestamped backup first:

```sh
sh examples/raspberry-pi/prepare-deployment.sh --profile pi3a-plus \
  --version sha-<published-commit> --replace-env
```

The script stages `docker-compose.yaml`, `.env`, `.env.example`, both helper
scripts, `.gitignore`, and this README in the deployment directory. It does not
copy config or image assets. Use `--profile`, `--version`, `--drm-device`, or
`--drm-gid` to override detection. The Pi profile mapping is:

- Pi 4 defaults to profile `pi4`, `/dev/dri/card1`, and GID `44` for Agentlab.
- The tested Pi 3 A+ uses profile `pi3a-plus`, `/dev/dri/card0`, and GID `44`.
- For Pi 3B, select `pi3b` and inspect the actual card and group first.

If `~/containers/ribbonfish` exists but is not writable, the script stops and
reports that directly. Make the deployment directory user-owned once, then
rerun the script. `verify-deployment.sh --preflight` checks the device and
GID, sync/network consistency, pinned image, and resolved Compose
configuration. After `up -d`, the full verifier also checks the running image,
network mode, loaded display config, and successful frame output. Use
`docker compose -p ribbonfish run --rm agent -list-displays` to inspect
connector state:

```sh
docker compose -p ribbonfish logs -f agent
```

The service defaults to `network_mode: none`. Pulling the image needs a network
connection; after it is present locally, the service itself can start offline.
The image contains a starter playlist, and the named `ribbonfish-state` volume
holds the cache, last-good manifest, frames, and device credential. The
container runs as UID 65532 with a read-only root filesystem and no added
capabilities.

After a PR merges into `main` and verification passes,
`.github/workflows/docker-publish.yml` publishes
`cyanautomation/ribbonfish` for AMD64, ARM64, and ARMv7, tagged `latest` and
`sha-<merge-commit-SHA>`. `latest` advances to the newest verified merge; the
deployment helper pins the immutable SHA tag automatically. The separate
`.github/workflows/publish-agent.yml` publishes ARMv7 and ARM64 images to
`ghcr.io/cyanautomation/ribbonfish` when a `v*` tag is pushed. GHCR package
visibility must allow Pi pulls, or the Pi must log in with a token that can
read the package.

## Optional Cloudflare sync and enrollment

The sync Worker serves a device-specific versioned manifest and only the R2
image hashes assigned to that device. D1 stores credential hashes; the Pi
stores only its own random token in the persistent state volume. The container
image contains no Cloudflare account credential. Worker setup, publishing a
manifest, enrollment-code generation, and revocation instructions are in
[`../../workers/device-sync/README.md`](../../workers/device-sync/README.md).

Sync is an explicit opt-in. Set the Worker URL and device ID to generate a
`bridge` network configuration; the verifier rejects sync without bridge
networking or bridge networking without sync. The helper can write those
settings directly:

```sh
sh examples/raspberry-pi/prepare-deployment.sh \
  --profile pi3a-plus --version sha-<published-commit> \
  --sync-url https://ribbonfish.scheimann.workers.dev \
  --device-id ribbonfish-01 --replace-env
```

Or set these values in `.env`:

```dotenv
RIBBONFISH_NETWORK_MODE=bridge
RIBBONFISH_SYNC_URL=https://ribbonfish.scheimann.workers.dev
RIBBONFISH_DEVICE_ID=ribbonfish-01
RIBBONFISH_SYNC_INTERVAL=1m
```

Exchange a one-time code through stdin. This writes the device token to the
same named volume used by the service and does not print the token:

```sh
read -r -s -p 'One-time code: ' enrollment_code
printf '\n'
printf '%s' "$enrollment_code" | docker compose -p ribbonfish run --rm -T agent -enroll
unset enrollment_code
docker compose -p ribbonfish up -d
```

The agent starts local playback before polling. It verifies the manifest and
each image's size and SHA-256 digest, saves a complete last-good snapshot, and
changes playlists only after all assets pass validation. On network or
validation errors it retains the current content and retries with backoff.
For fully offline operation, leave the sync URL empty and networking set to
`none`.

## Software simulator

From the repository root, run the source-built simulator:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml config
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml logs -f agent
```

The simulator uses the bundled `simulator` profile, does not open DRM devices,
and writes PNG frames into its persistent state volume. Copy frames out with:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-left.png ./display-left.png
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-right.png ./display-right.png
```

For a one-display Pi 3B simulation, set
`RIBBONFISH_SIMULATOR_PROFILE=simulator-pi3b`; `simulator-pi4` writes two
outputs. The simulator's size comes from its configured mode; it does not
query monitor EDID or emulate DRM, memory pressure, or a specific Pi model.

The published-image simulator can run without a source checkout:

```sh
docker compose -f examples/raspberry-pi/docker-compose.published.yaml up -d
docker compose -f examples/raspberry-pi/docker-compose.published.yaml logs -f agent
```

Set `RIBBONFISH_VERSION` to a `sha-...` tag to pin the image. Both simulator
examples disable container networking and need no config or asset mounts.
Simulator output and emulated ARM containers validate software behavior, not
physical scanout, GPU timing, or thermal performance.

## DRM/KMS setup and hardware limits

The Linux backend opens the configured DRM card, requests DRM master, selects
the configured connector and mode, allocates XRGB8888 dumb buffers, and uses
legacy KMS modesetting plus page flips. It does not use X11 or Wayland. The
host display server must release the selected card. The backend does not
restore the previous CRTC mode itself; the framebuffer console resumed its
original framebuffer after a clean stop on the tested Pi 3 A+, but this should
be checked on each target kernel.

Before deployment, inspect device nodes, groups, connectors, and modes:

```sh
ls -l /dev/dri
stat -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

The hardware acceptance run used `ribbonfish-01`, a Raspberry Pi 3 Model A
Plus Rev 1.0 with Debian 13.7 ARM64, kernel `6.18.50+rpt-rpi-v8`, and Docker
Engine 26.1.5. It verified `/dev/dri/card0` as `root:video` (GID 44),
HDMI-A-1 at 1920x1080@60, non-root read-only operation with capabilities
dropped and no network, repeated framebuffer updates, and visible sample
slides. The agent used about 26 MiB RSS on the 512 MiB Pi. This did not measure
visual quality or scaling. Docker memory limits were unavailable on that
kernel, so do not rely on `docker stats` for memory accounting there. Agentlab
has no connected HDMI monitor.

`-list-displays` reports sysfs metadata; it does not test DRM permissions,
master acquisition, mode-setting, or pixels. A Compose check, simulator PNG,
or QEMU smoke test is not hardware acceptance. Pi 3B scanout, Pi 4 simultaneous
dual-HDMI scanout, HDMI hotplug recovery, and cross-kernel DRM ownership still
need direct testing. A failed page flip currently faults that surface until
restart. Connector names, card numbering, available modes, and DRM master
behavior vary by host.

For Docker-only deployments without the Compose plugin, use the bundled profile
and a single persistent state volume. For example, after pulling the image and
checking the Pi 3 A+ card and group:

```sh
docker volume create ribbonfish-state
docker run --detach --name ribbonfish --restart unless-stopped --stop-timeout 15 \
  --init --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 65532:65532 \
  --device /dev/dri/card0:/dev/dri/card0 --group-add 44 \
  --env RIBBONFISH_PROFILE=pi3a-plus \
  --mount type=volume,src=ribbonfish-state,dst=/var/lib/ribbonfish \
  cyanautomation/ribbonfish:latest
```

Do not add `privileged: true` to work around a DRM permission or ownership
failure. Inspect the selected card owner, group, connector status, and active
display services instead.
