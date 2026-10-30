# Raspberry Pi deployment

Ribbonfish ships a default profile and starter images inside the container.
The Compose deployment can run with networking disabled and does not need a
host-mounted config or asset directory. Once the image is on the Pi, the local
playlist works offline. Optional authenticated sync can replace its content
from a Cloudflare Worker backed by R2; it keeps using the last valid snapshot
when the Worker cannot be reached.

The DRM/KMS output is experimental. One-display mode-setting, frame updates,
and visible sample slides have been confirmed on a Pi 3 A+. Pi 3B scanout and
Pi 4 physical dual-display acceptance remain open. The Pi 4 hardware profile
expects both `HDMI-A-1` and `HDMI-A-2` to be connected and active; a headless Pi
4 cannot pass preflight or verify physical scanout until both displays are
connected. The Pi 4 setup below selects the KMS device independently of its
variable `card0`/`card1` numbering, but does not replace physical acceptance.

## Files

- `docker-compose.yaml`: hardware deployment using a bundled profile and one
  persistent state volume
- `docker-compose.simulator.yaml`: source-built software simulation
- `docker-compose.published.yaml`: published-image simulation
- `.env.example`: profile, DRM device/group, and optional sync settings
- `install.sh`: clone-free bootstrap that downloads the deployment kit at the
  current main commit into a temporary directory
- `prepare-deployment.sh`: detects the Pi profile and DRM group, prepares the
  deployment image, and stages the complete deployment kit under
  `~/containers/ribbonfish`
- `verify-deployment.sh`: validates the configured image, checks connected
  DRM targets, and confirms the running container has displayed a frame
- `assets/` and `hardware-config.*.json`: source examples; the container
  profiles and starter images are bundled from `agent/defaults/`

## Install and start

On a prepared Pi with `curl` and Docker Compose, download and run the
clone-free installer:

Run this as your regular Pi user. If `~/containers/ribbonfish` already exists
as an empty root-owned directory, pass `--fix-target-owner`; the installer may
ask for your sudo password to take ownership of that empty directory. It does
not change ownership of a populated directory. If the target contains files,
choose another target or fix its ownership yourself.

```sh
curl -fsSL https://raw.githubusercontent.com/CyanAutomation/ribbonfish/main/examples/raspberry-pi/install.sh -o /tmp/ribbonfish-install.sh
sh /tmp/ribbonfish-install.sh --fix-target-owner
cd ~/containers/ribbonfish
docker compose -p ribbonfish pull
./verify-deployment.sh --preflight
docker compose -p ribbonfish up -d
./verify-deployment.sh
```

The installer reads the current main commit from GitHub, downloads the
deployment files pinned to that commit into a temporary directory, and removes
the temporary files after staging. It does not require Git or a repository
clone. It needs outbound HTTPS access to GitHub and the image registry. The
Pi profile helper detects Pi 3 A+, Pi 3 B, or Pi 4, reads the numeric group
from the selected DRM device, and writes the hardware and requested sync
settings into `.env`. For Pi 4 it selects
`/dev/dri/by-path/platform-gpu-card`, a stable alias for the KMS display card.
Compose defaults to the published `latest` image. For repeatable deployments,
pin an immutable `sha-<merge-commit-SHA>` tag or a manifest digest with
`--image`:

```sh
sh /tmp/ribbonfish-install.sh --image "cyanautomation/ribbonfish:sha-$MERGE_SHA"
```

Set `MERGE_SHA` to the 40-character merge commit SHA, or use a digest such as
`cyanautomation/ribbonfish@sha256:<manifest-digest>`. If the deployment already
has a `.env`, `--image` updates only `RIBBONFISH_IMAGE` and makes a private
timestamped backup first. The service starts offline (`network_mode: none`).
The generated environment is mode `0600`; other existing `.env` values are
preserved by default.

If you already have a repository checkout, you can stage from it directly:

```sh
sh examples/raspberry-pi/prepare-deployment.sh
```

To replace a legacy `.env`, the helper makes a private timestamped backup
first:

```sh
sh examples/raspberry-pi/prepare-deployment.sh --profile pi3a-plus \
  --replace-env
```

The script stages `docker-compose.yaml`, `docker-compose.published.yaml`,
`.env`, `.env.example`, the installer and helper scripts, `.gitignore`, and
this README in the deployment directory. It does not copy config or image
assets. Use `--profile`, `--drm-device`, or `--drm-gid` to override detection.
The Pi profile mapping is:

- Pi 4 uses profile `pi4`, which requires both HDMI connectors listed above.
  The helper defaults to `/dev/dri/by-path/platform-gpu-card`; check that the
  alias exists and points to the KMS display device before starting Compose.
- Ribbonfish is a Pi 3 A+ using profile `pi3a-plus`, `/dev/dri/card0`, and GID `44`.
- For Pi 3B, select `pi3b` and inspect the actual card and group first.

If `~/containers/ribbonfish` exists but is not writable, rerun with
`--fix-target-owner` only when it is an empty root-owned directory. For a
populated directory, choose a user-writable target or fix its ownership
manually.

`verify-deployment.sh --preflight` requires the image to be present locally, so
pull it first. Preflight validates the resolved image and Compose configuration,
then starts a temporary non-networked container to check the configured DRM
connector and requested resolution through sysfs. A disconnected configured
connector is reported as a warning and does not prevent startup; other device,
connector, or mode configuration errors still fail preflight. The running agent
marks disconnected outputs as `connector_disconnected` and reports degraded
health while continuing to render on available displays. Preflight does not
change scanout.
After `up -d`, the full verifier repeats that check, confirms that the running
container uses the configured image ID, and waits up to 30 seconds for the
agent to log a successful frame update on an available display. Set
`RIBBONFISH_VERIFY_TIMEOUT` to change that startup wait. Use these commands to
inspect connector metadata, validate configured targets in the running image,
or follow the agent logs:

```sh
docker compose -p ribbonfish run --rm agent -list-displays
docker compose -p ribbonfish exec -T agent /ribbonfish -check-displays
docker compose -p ribbonfish logs -f agent
```

These commands use the `agent` service name from this repository's Compose
file. For an existing deployment with another service name, run
`docker compose config --services` and substitute the listed name.

### Raspberry Pi 4 DRM device selection

Do not assume that `/dev/dri/card0` or `card1` is the display controller on a
Pi 4. The V3D render driver and VC4 KMS display driver can receive different
card numbers on different boots or devices. The Ribbonfish Pi 4 setup uses the
KMS alias, which resolves to the correct numbered card on supported Raspberry
Pi OS images:

```sh
ls -l /dev/dri/by-path
readlink -f /dev/dri/by-path/platform-gpu-card
stat -L -c '%g %G %n' /dev/dri/by-path/platform-gpu-card
```

The `readlink` command shows which `cardN` currently backs the alias; the
`stat -L` command reports the target device's numeric group. The install helper
uses these semantics when it detects a Pi 4 and writes `.env`. If you edit
`.env` manually, use profile `pi4`, set
`RIBBONFISH_DRM_DEVICE=/dev/dri/by-path/platform-gpu-card`, and set
`RIBBONFISH_DRM_GID` to the numeric group reported by `stat -L` (often `44` on
Raspberry Pi OS). The alias must exist before running Compose. The helper
preserves an existing `.env` by default, so update a previous `card0` or
`card1` setting manually; `prepare-deployment.sh` will not silently replace it.
The display preflight matches the alias to each connector's owning card by
Linux device number.

If that alias is missing, inspect `ribbonfish -list-displays` output and
`/sys/class/drm` to identify the card that owns `HDMI-A-1` and `HDMI-A-2`, then
set `RIBBONFISH_DRM_DEVICE` and its actual group explicitly. Do not select a
card just because its number matches another Pi.

If startup logs report `read DRM resources ... operation not supported`, check
that the mapped device is the KMS display card. A render-only V3D node does not
provide the modesetting interface Ribbonfish needs. After correcting the path
and group in `.env`, run preflight and recreate the container so Docker applies
the updated device mapping:

```sh
./verify-deployment.sh --preflight
docker compose -p ribbonfish up -d --force-recreate
```

Both HDMI displays must be connected for the Pi 4 profile's connector check to
pass.

If preflight says a connector belongs to `/dev/dri/cardN` but the configured
device is `/dev/dri/by-path/platform-gpu-card`, the agent image predates
by-path-aware preflight. Update to an image built from a revision with this
support before using the deployment verifier.

The service defaults to `network_mode: none`. Pulling the image needs a network
connection; after it is present locally, the service itself can start offline.
The image contains a starter playlist, and the Compose project-scoped
`ribbonfish_ribbonfish-state` volume holds the cache, last-good playlist
snapshot, frames, and device identity key. The container runs as UID 65532 with
a read-only root filesystem and no added capabilities.

Protected `main` pushes that change `agent/**` and pass verification publish
`cyanautomation/ribbonfish` for AMD64, ARM64, and ARMv7 through
`.github/workflows/docker-publish.yml`, tagged `sha-<commit-SHA>`. `latest`
advances only when the published commit is still the `main` tip, and the Pi
deployment defaults to that tag. The separate
`.github/workflows/publish-agent.yml` publishes ARMv7 and ARM64 images to
`ghcr.io/cyanautomation/ribbonfish` with `main` and `sha-<commit-SHA>` tags.
GHCR package visibility must allow Pi pulls, or the Pi must log in with a token
that can read the package.

## Optional Cloudflare sync and enrollment

The sync Worker serves one globally active versioned playlist to every
approved device. New devices create a persistent Ed25519 key in the state
volume and send a signed request automatically; the private key never leaves
the Pi. The Worker stores the public key and keeps the request pending until
you approve it in the management console. The container image contains no
Cloudflare account credential. Worker setup, playlist publishing, approval,
and revocation instructions are in
[`../../workers/device-sync/README.md`](../../workers/device-sync/README.md).

Sync is an explicit opt-in. Set the Worker URL and device ID to generate a
`bridge` network configuration; the verifier rejects sync without bridge
networking or bridge networking without sync. The helper can write those
settings directly:

```sh
sh examples/raspberry-pi/prepare-deployment.sh \
  --profile pi3a-plus \
  --sync-url https://ribbonfish.scheimann.workers.dev \
  --device-id ribbonfish-01 --replace-env
```

Or set these values in `.env`:

```dotenv
RIBBONFISH_NETWORK_MODE=bridge
RIBBONFISH_SYNC_URL=https://ribbonfish.scheimann.workers.dev
RIBBONFISH_DEVICE_ID=ribbonfish-01
```

On first start, the agent displays the device ID and a grouped fingerprint on
its screens while it waits. In the production management console, open
**Waiting for approval**, compare the entire fingerprint with the physical
display, then approve the device. Once approved, the agent downloads the
currently active playlist and verified assets automatically, then keeps a
last-good local copy for offline playback. The Worker supplies playlist
content only; the Pi's DRM card, connectors, and display profile still come
from the local image and must match the attached hardware. The device-sync
Worker keeps management routes disabled; use the separate production
management console behind Cloudflare Access to approve production devices.

Existing devices can continue to use the legacy one-time-code flow. New devices
do not need a code or a separate enrollment command. To manually provision an
older agent, exchange a one-time code through stdin; it writes the device token
to the same named volume and does not print the token:

```sh
read -r -s -p 'One-time code: ' enrollment_code
printf '\n'
printf '%s' "$enrollment_code" | docker compose -p ribbonfish run --rm -T agent -enroll
unset enrollment_code
docker compose -p ribbonfish up -d
```

The agent starts local playback before polling. It verifies the shared playlist
and each image's size and SHA-256 digest, saves a complete last-good snapshot,
and activates the new playlist and its rotation interval only after all assets
pass validation. On network or validation errors it retains the current content
and retries with backoff.
For fully offline operation, leave the sync URL empty and networking set to
`none`.

## Software simulator

From the repository root, run the source-built simulator:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml config
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml logs -f agent
```

The simulator defaults to `simulator-pi3a-plus`, which matches Ribbonfish's
single `display-main` at 1920x1080. It does not open DRM devices and writes PNG
frames into its persistent state volume. Copy the frame out with:

```sh
docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml cp agent:/var/lib/ribbonfish/frames/display-main.png ./display-main.png
```

For a one-display Pi 3B simulation, set
`RIBBONFISH_SIMULATOR_PROFILE=simulator-pi3b`. Set it to `simulator-pi4` for
the two-display Pi 4 profile. The source-built Compose file targets ARM64;
both simulator files allow up to four CPUs (`RIBBONFISH_SIMULATOR_CPUS`,
default `4`). They default to a 512 MiB container memory limit; set
`RIBBONFISH_SIMULATOR_MEMORY_LIMIT=3g` for the 4 GB Pi 4. The limit applies to
the container, not the whole Pi. The simulator does not cap CPU frequency or
emulate the Pi's GPU, DRM/KMS scanout, thermal behavior, or host memory
pressure.

The two inspected Pi 4s are Model B Rev 1.5, each with four ARM64 CPUs and
Debian 13 (Trixie) on kernel `6.18.50+rpt-rpi-v8`. Both report a maximum CPU
frequency of 1.8 GHz with the `ondemand` governor. One exposes about 0.9 GiB
of RAM and the other about 3.8 GiB. Both report a 76 MiB GPU memory allocation.
The stable `/dev/dri/by-path/platform-gpu-card` alias resolves to `card1` on
one unit and `card0` on the other. Both HDMI connectors were disconnected
during inspection, so their preferred display modes could not be read. The
Pi 4 simulator therefore retains 1920x1080@60 as a nominal target mode; it
renders PNG frames at 1920x1080, but does not scan out at 60 Hz or read EDID.

For example, run the source-built simulator against the lower-memory Pi 4
budget with:

```sh
RIBBONFISH_SIMULATOR_PROFILE=simulator-pi4 \
  docker compose -f examples/raspberry-pi/docker-compose.simulator.yaml up --build -d
```

To use the 4 GB Pi's container budget, set
`RIBBONFISH_SIMULATOR_MEMORY_LIMIT=3g` on that command. The published-image
simulator accepts the same variables.

The published-image simulator can run without a source checkout:

```sh
cd ~/containers/ribbonfish
docker compose -f docker-compose.published.yaml up -d
docker compose -f docker-compose.published.yaml logs -f agent
```

The published-image simulator uses the `latest` image. Both simulator examples
disable container networking and need no config or asset mounts. Select the
two-display Pi 4 software profile with:

```sh
RIBBONFISH_SIMULATOR_PROFILE=simulator-pi4 docker compose -f docker-compose.published.yaml up -d
```

Omit the environment assignment to use the default single-display Pi 3 A+
simulator profile.
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
stat -L -c '%g %G %n' /dev/dri/card*
ls /sys/class/drm
```

The hardware acceptance run used `ribbonfish-01`, a Raspberry Pi 3 Model A
Plus Rev 1.0 with Debian 13.7 ARM64, kernel `6.18.50+rpt-rpi-v8`, and Docker
Engine 26.1.5. It verified `/dev/dri/card0` as `root:video` (GID 44),
HDMI-A-1 at 1920x1080@60, non-root read-only operation with capabilities
dropped and no network, repeated framebuffer updates, and visible sample
slides. The HDMI display is currently connected and outputting as expected.
The agent used about 26 MiB RSS on the 512 MiB Pi. On the Pi 4, the published
simulator's two 1920x1080 frames rendered successfully; its agent process used
about 198–252 MiB RSS during the observed run. The Pi 4 had no HDMI displays
connected, so this validated software rendering only. On that host,
`docker stats` reported `0B / 0B`, so it was not useful for memory accounting.
For a running container, inspect process RSS with `docker top` instead; its
`RSS` column is in KiB and reflects resident process memory, not all container
memory or GPU allocations:

```sh
docker top "$(docker compose -f docker-compose.published.yaml ps -q agent)" -eo pid,rss,comm
```

`-list-displays` reports sysfs metadata. `-check-displays` additionally
compares the configured card, connector, connection status, and requested
resolution against sysfs. Sysfs mode names do not expose refresh rates, so the
check cannot confirm an exact `@60` timing. It does not open DRM, test
permissions, acquire DRM master, set a mode, or verify pixels.
`verify-deployment.sh` runs this read-only check against the active container
before confirming recent frame updates. It complements the confirmed visible
output; it does not replace checking pixels during future hardware changes.
Pi 3B scanout, Pi 4 simultaneous dual-HDMI scanout, HDMI hotplug recovery, and
cross-kernel DRM ownership still need direct testing. A failed page flip
currently faults that surface until restart. Connector names, card numbering,
available modes, and DRM master behavior vary by host.

For Docker-only deployments without the Compose plugin, use the bundled profile
and a single persistent state volume. For example, after pulling the image and
checking the Pi 3 A+ card and group:

```sh
docker volume create ribbonfish_ribbonfish-state
docker run --detach --name ribbonfish --restart unless-stopped --stop-timeout 15 \
  --init --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 65532:65532 \
  --device /dev/dri/card0:/dev/dri/card0 --group-add 44 \
  --env RIBBONFISH_PROFILE=pi3a-plus \
  --mount type=volume,src=ribbonfish_ribbonfish-state,dst=/var/lib/ribbonfish \
  cyanautomation/ribbonfish:latest
```

Do not add `privileged: true` to work around a DRM permission or ownership
failure. Inspect the selected card owner, group, connector status, and active
display services instead.
