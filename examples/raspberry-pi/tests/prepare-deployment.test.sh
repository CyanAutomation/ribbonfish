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
      'config --images') printf '%s\\n' 'cyanautomation/ribbonfish:$version' ;;
      'ps -q') [ "\${2:-}" = agent ] && printf '%s\\n' test-container ;;
      *) echo "unexpected docker compose call: \$*" >&2; exit 2 ;;
    esac
    ;;
  inspect)
    printf '%s\\n' 'cyanautomation/ribbonfish:$version|running|none'
    ;;
  logs)
    printf '%s\\n' 'level=INFO msg="agent configuration loaded" displays=1 playlists=1'
    printf '%s\\n' 'level=INFO msg="display frame updated" display_id=display-main'
    ;;
  *) echo "unexpected docker call: \$*" >&2; exit 2 ;;
esac
EOF
chmod +x "$temp_dir/bin/docker"
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh"

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
