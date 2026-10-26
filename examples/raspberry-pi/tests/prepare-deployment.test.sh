#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

export HOME="$temp_dir/home"
mkdir -p "$HOME"
version=sha-128b052157f2b3c0d80e282eb1f7ab982ccb9411

sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--version "$version" \
	--drm-device /dev/null \
	--drm-gid 0

target_dir="$HOME/containers/ribbonfish"
test -f "$target_dir/docker-compose.yaml"
test -f "$target_dir/.env"
grep -Fx "RIBBONFISH_VERSION=$version" "$target_dir/.env"
grep -Fx 'RIBBONFISH_PROFILE=pi3a-plus' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DRM_DEVICE=/dev/null' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DRM_GID=0' "$target_dir/.env"
grep -Fx 'RIBBONFISH_NETWORK_MODE=none' "$target_dir/.env"

mkdir -p "$temp_dir/bin"
cat > "$temp_dir/bin/docker" <<EOF
#!/bin/sh
case "\$1" in
  compose)
    shift
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --project-directory|-p) shift 2 ;;
        config) command=config; shift; break ;;
        ps) command=ps; shift; break ;;
        *) echo "unexpected docker compose option: \$1" >&2; exit 2 ;;
      esac
    done
    case "\$command \${1:-}" in
      'config --quiet') exit 0 ;;
      'config --images') printf '%s\\n' "\${FAKE_DOCKER_IMAGE:-cyanautomation/ribbonfish:$version}" ;;
      'ps -q') [ "\${2:-}" = agent ] && printf '%s\\n' test-container ;;
      *) echo "unexpected docker compose call: \$*" >&2; exit 2 ;;
    esac
    ;;
  image)
    [ "\${2:-}" = inspect ] || { echo "unexpected docker image call: \$*" >&2; exit 2; }
    printf '%s\\n' "\${FAKE_DOCKER_IMAGE_ID:-sha256:test-image-id}"
    ;;
  inspect)
    printf '%s\\n' "\${FAKE_DOCKER_IMAGE:-cyanautomation/ribbonfish:$version}|\${FAKE_DOCKER_RUNTIME_IMAGE_ID:-sha256:test-image-id}|running|none"
    ;;
  logs)
    printf '%s\\n' 'level=INFO msg="agent configuration loaded" displays=1 playlist_id=default'
    printf '%s\\n' 'level=INFO msg="display frame updated" display_id=display-main'
    ;;
  *) echo "unexpected docker call: \$*" >&2; exit 2 ;;
esac
EOF
chmod +x "$temp_dir/bin/docker"
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh"

awk -F= '$1 == "RIBBONFISH_VERSION" { $0 = "RIBBONFISH_VERSION=latest" } { print }' \
	"$target_dir/.env" >"$target_dir/.env.tmp"
mv "$target_dir/.env.tmp" "$target_dir/.env"
FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh" --preflight
FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh"
if FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest FAKE_DOCKER_RUNTIME_IMAGE_ID=sha256:stale-image \
	PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" >/dev/null 2>&1; then
	echo 'stale container image unexpectedly passed verification' >&2
	exit 1
fi

awk -F= '$1 == "RIBBONFISH_VERSION" { $0 = "RIBBONFISH_VERSION=nightly" } { print }' \
	"$target_dir/.env" >"$target_dir/.env.tmp"
mv "$target_dir/.env.tmp" "$target_dir/.env"
if PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight >/dev/null 2>&1; then
	echo 'unsupported mutable image tag unexpectedly passed verification' >&2
	exit 1
fi

awk -F= -v version="$version" '$1 == "RIBBONFISH_VERSION" { $0 = "RIBBONFISH_VERSION=" version } { print }' \
	"$target_dir/.env" >"$target_dir/.env.tmp"
mv "$target_dir/.env.tmp" "$target_dir/.env"

printf '%s\n' 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' >> "$target_dir/.env"
sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--version "$version" \
	--drm-device /dev/null \
	--drm-gid 0
grep -Fx 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' "$target_dir/.env"
if PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight >/dev/null 2>&1; then
	echo 'sync configuration without bridge networking unexpectedly passed' >&2
	exit 1
fi
sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--version "$version" \
	--drm-device /dev/null \
	--drm-gid 0 \
	--replace-env
backup=$(find "$target_dir" -maxdepth 1 -name '.env.backup.*' -print -quit)
test -n "$backup"
grep -Fx 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' "$backup"
grep -Fx 'RIBBONFISH_NETWORK_MODE=none' "$target_dir/.env"

sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--version "$version" \
	--drm-device /dev/null \
	--drm-gid 0 \
	--sync-url https://ribbonfish.scheimann.workers.dev \
	--device-id ribbonfish-01 \
	--replace-env
grep -Fx 'RIBBONFISH_NETWORK_MODE=bridge' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DEVICE_ID=ribbonfish-01' "$target_dir/.env"
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight

if output=$(sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --version "$version" --drm-device /dev/null --drm-gid 0 \
	--sync-url https://ribbonfish.scheimann.workers.dev 2>&1); then
	echo 'sync URL without a device ID unexpectedly succeeded' >&2
	exit 1
fi
case "$output" in
	*'--device-id is required when --sync-url is set'*) ;;
	*) echo "sync URL without device ID returned an unclear error: $output" >&2; exit 1 ;;
esac

if output=$(sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --version "$version" --drm-device /dev/null --drm-gid 0 \
	--device-id ribbonfish-01 2>&1); then
	echo 'device ID without a sync URL unexpectedly succeeded' >&2
	exit 1
fi
case "$output" in
	*'--sync-url is required when --device-id is set'*) ;;
	*) echo "device ID without sync URL returned an unclear error: $output" >&2; exit 1 ;;
esac

if sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --version "$version" --drm-device /dev/null --drm-gid 0 \
	--sync-url http://insecure.example --device-id ribbonfish-01 >/dev/null 2>&1; then
	echo 'HTTP sync URL unexpectedly succeeded' >&2
	exit 1
fi

if sh "$script_dir/prepare-deployment.sh" --profile invalid --version "$version" >/dev/null 2>&1; then
	echo 'invalid profile unexpectedly succeeded' >&2
	exit 1
fi

if sh "$script_dir/prepare-deployment.sh" --profile pi3a-plus --version latest >/dev/null 2>&1; then
	echo 'mutable image tag unexpectedly succeeded' >&2
	exit 1
fi

printf '%s\n' 'prepare-deployment tests passed'
