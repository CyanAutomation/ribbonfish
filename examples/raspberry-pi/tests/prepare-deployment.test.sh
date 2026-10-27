#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

export HOME="$temp_dir/home"
mkdir -p "$HOME"
sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--drm-device /dev/null \
	--drm-gid 0

target_dir="$HOME/containers/ribbonfish"
test -f "$target_dir/docker-compose.yaml"
test -x "$target_dir/install.sh"
test -f "$target_dir/.env"
grep -Fx 'RIBBONFISH_PROFILE=pi3a-plus' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DRM_DEVICE=/dev/null' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DRM_GID=0' "$target_dir/.env"
grep -Fx 'RIBBONFISH_NETWORK_MODE=none' "$target_dir/.env"
if grep -Eq '^(RIBBONFISH_VERSION|RIBBONFISH_CACHE_DIR|RIBBONFISH_SYNC_URL|RIBBONFISH_SYNC_INTERVAL|RIBBONFISH_DEVICE_ID)=' "$target_dir/.env"; then
	echo 'generated .env contains a fixed tag or redundant defaults' >&2
	exit 1
fi
grep -F 'image: cyanautomation/ribbonfish:latest' "$target_dir/docker-compose.yaml"
grep -F 'RIBBONFISH_PROFILE: ${RIBBONFISH_PROFILE:?Set RIBBONFISH_PROFILE in .env}' "$target_dir/docker-compose.yaml"
grep -F 'RIBBONFISH_DRM_DEVICE: ${RIBBONFISH_DRM_DEVICE:?Set RIBBONFISH_DRM_DEVICE in .env}' "$target_dir/docker-compose.yaml"
grep -F '${RIBBONFISH_DRM_GID:?Set RIBBONFISH_DRM_GID in .env}' "$target_dir/docker-compose.yaml"
if grep -Eq '^(RIBBONFISH_VERSION|RIBBONFISH_CACHE_DIR|RIBBONFISH_SYNC_INTERVAL)=' "$target_dir/.env.example"; then
	echo '.env.example contains a fixed tag or redundant defaults' >&2
	exit 1
fi

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
        exec) command=exec; shift; break ;;
        *) echo "unexpected docker compose option: \$1" >&2; exit 2 ;;
      esac
    done
    case "\$command \${1:-}" in
      'config --quiet') exit 0 ;;
      'config --images') printf '%s\\n' "\${FAKE_DOCKER_IMAGE:-cyanautomation/ribbonfish:latest}" ;;
      'ps -q') [ "\${2:-}" = agent ] && printf '%s\\n' test-container ;;
      'exec -T')
        [ "\${2:-}" = agent ] && [ "\${3:-}" = /ribbonfish ] && [ "\${4:-}" = -check-displays ] || { echo "unexpected docker compose exec command: \$*" >&2; exit 2; }
        if [ "\${FAKE_DOCKER_DISPLAY_CHECK_FAIL:-0}" = 1 ]; then
          printf '%s\\n' 'DRM connector HDMI-A-1 is disconnected' >&2
          exit 1
        fi
        printf '%s\\n' 'DRM display preflight passed: device=/dev/dri/card0 displays=1'
        printf '%s\\n' 'display_id=display-main connector=HDMI-A-1 status=connected requested_mode=preferred advertised_modes=32'
        ;;
      *) echo "unexpected docker compose call: \$*" >&2; exit 2 ;;
    esac
    ;;
  image)
    [ "\${2:-}" = inspect ] || { echo "unexpected docker image call: \$*" >&2; exit 2; }
    printf '%s\\n' "\${FAKE_DOCKER_IMAGE_ID:-sha256:test-image-id}"
    ;;
  inspect)
    printf '%s\\n' "\${FAKE_DOCKER_IMAGE:-cyanautomation/ribbonfish:latest}|\${FAKE_DOCKER_RUNTIME_IMAGE_ID:-sha256:test-image-id}|running|none"
    ;;
  logs)
    if [ "\${FAKE_DOCKER_FRAME_AFTER:-0}" -gt 0 ] || [ "\${FAKE_DOCKER_CONFIG_AFTER:-0}" -gt 0 ]; then
      count_file=\${FAKE_DOCKER_LOG_COUNT_FILE:?set FAKE_DOCKER_LOG_COUNT_FILE}
      count=0
      [ ! -f "\$count_file" ] || count=\$(cat "\$count_file")
      count=\$((count + 1))
      printf '%s\\n' "\$count" >"\$count_file"
      config_after=\${FAKE_DOCKER_CONFIG_AFTER:-0}
      frame_after=\${FAKE_DOCKER_FRAME_AFTER:-0}
      if [ "\$config_after" -eq 0 ] || [ "\$count" -ge "\$config_after" ]; then
        printf '%s\\n' 'level=INFO msg="agent configuration loaded" displays=1 playlist_id=default'
      fi
      if [ "\$frame_after" -eq 0 ] || [ "\$count" -ge "\$frame_after" ]; then
        printf '%s\\n' 'level=INFO msg="display frame updated" display_id=display-main'
      fi
    else
      printf '%s\\n' 'level=INFO msg="agent configuration loaded" displays=1 playlist_id=default'
      printf '%s\\n' 'level=INFO msg="display frame updated" display_id=display-main'
    fi
    ;;
  *) echo "unexpected docker call: \$*" >&2; exit 2 ;;
esac
EOF
chmod +x "$temp_dir/bin/docker"
cat > "$temp_dir/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$temp_dir/bin/git" <<'EOF'
#!/bin/sh
echo 'installer unexpectedly invoked git' >&2
exit 99
EOF
chmod +x "$temp_dir/bin/sleep" "$temp_dir/bin/git"
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh"
if output=$(FAKE_DOCKER_FRAME_AFTER=2 FAKE_DOCKER_LOG_COUNT_FILE="$temp_dir/log-count" \
	RIBBONFISH_VERIFY_TIMEOUT=3 PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh" 2>&1); then
	case "$output" in
		*'Deployment verified:'*) ;;
		*) echo "delayed frame update returned unclear output: $output" >&2; exit 1 ;;
	esac
else
	echo "verifier failed before delayed frame update appeared: $output" >&2
	exit 1
fi
test "$(cat "$temp_dir/log-count")" -ge 2
if output=$(FAKE_DOCKER_CONFIG_AFTER=2 FAKE_DOCKER_FRAME_AFTER=3 \
	FAKE_DOCKER_LOG_COUNT_FILE="$temp_dir/config-count" \
	RIBBONFISH_VERIFY_TIMEOUT=3 PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh" 2>&1); then
	case "$output" in
		*'Deployment verified:'*) ;;
		*) echo "delayed startup logs returned unclear output: $output" >&2; exit 1 ;;
	esac
else
	echo "verifier failed before delayed startup logs appeared: $output" >&2
	exit 1
fi
test "$(cat "$temp_dir/config-count")" -ge 3
if output=$(FAKE_DOCKER_FRAME_AFTER=99 FAKE_DOCKER_LOG_COUNT_FILE="$temp_dir/no-frame-count" \
	RIBBONFISH_VERIFY_TIMEOUT=2 PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh" 2>&1); then
	echo 'verifier passed without a successful frame update' >&2
	exit 1
fi
case "$output" in
	*'timed out after 2s waiting for a successful display frame update'*) ;;
	*) echo "frame timeout returned unclear output: $output" >&2; exit 1 ;;
esac
if FAKE_DOCKER_DISPLAY_CHECK_FAIL=1 PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" >/dev/null 2>&1; then
	echo 'disconnected DRM connector unexpectedly passed deployment verification' >&2
	exit 1
fi

FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh" --preflight
FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest PATH="$temp_dir/bin:$PATH" \
	sh "$script_dir/verify-deployment.sh"
if FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:sha-128b052157f2b3c0d80e282eb1f7ab982ccb9411 \
	PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight >/dev/null 2>&1; then
	echo 'non-latest image unexpectedly passed verification' >&2
	exit 1
fi
if FAKE_DOCKER_IMAGE=cyanautomation/ribbonfish:latest FAKE_DOCKER_RUNTIME_IMAGE_ID=sha256:stale-image \
	PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" >/dev/null 2>&1; then
	echo 'stale container image unexpectedly passed verification' >&2
	exit 1
fi

printf '%s\n' 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' >> "$target_dir/.env"
sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--drm-device /dev/null \
	--drm-gid 0
grep -Fx 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' "$target_dir/.env"
if PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight >/dev/null 2>&1; then
	echo 'sync configuration without bridge networking unexpectedly passed' >&2
	exit 1
fi
sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--drm-device /dev/null \
	--drm-gid 0 \
	--replace-env
backup=$(find "$target_dir" -maxdepth 1 -name '.env.backup.*' -print -quit)
test -n "$backup"
grep -Fx 'RIBBONFISH_SYNC_URL=https://sync.example.workers.dev' "$backup"
grep -Fx 'RIBBONFISH_NETWORK_MODE=none' "$target_dir/.env"

sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus \
	--drm-device /dev/null \
	--drm-gid 0 \
	--sync-url https://ribbonfish.scheimann.workers.dev \
	--device-id ribbonfish-01 \
	--replace-env
grep -Fx 'RIBBONFISH_NETWORK_MODE=bridge' "$target_dir/.env"
grep -Fx 'RIBBONFISH_DEVICE_ID=ribbonfish-01' "$target_dir/.env"
PATH="$temp_dir/bin:$PATH" sh "$script_dir/verify-deployment.sh" --preflight

if output=$(sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --drm-device /dev/null --drm-gid 0 \
	--sync-url https://ribbonfish.scheimann.workers.dev 2>&1); then
	echo 'sync URL without a device ID unexpectedly succeeded' >&2
	exit 1
fi
case "$output" in
	*'--device-id is required when --sync-url is set'*) ;;
	*) echo "sync URL without device ID returned an unclear error: $output" >&2; exit 1 ;;
esac

if output=$(sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --drm-device /dev/null --drm-gid 0 \
	--device-id ribbonfish-01 2>&1); then
	echo 'device ID without a sync URL unexpectedly succeeded' >&2
	exit 1
fi
case "$output" in
	*'--sync-url is required when --device-id is set'*) ;;
	*) echo "device ID without sync URL returned an unclear error: $output" >&2; exit 1 ;;
esac

if sh "$script_dir/prepare-deployment.sh" \
	--profile pi3a-plus --drm-device /dev/null --drm-gid 0 \
	--sync-url http://insecure.example --device-id ribbonfish-01 >/dev/null 2>&1; then
	echo 'HTTP sync URL unexpectedly succeeded' >&2
	exit 1
fi

if sh "$script_dir/prepare-deployment.sh" --profile invalid >/dev/null 2>&1; then
	echo 'invalid profile unexpectedly succeeded' >&2
	exit 1
fi

if sh "$script_dir/prepare-deployment.sh" --version latest >/dev/null 2>&1; then
	echo 'removed image-version option unexpectedly succeeded' >&2
	exit 1
fi

install_target="$HOME/containers/ribbonfish-no-clone"
FAKE_RIBBONFISH_SOURCE_DIR=$(CDPATH= cd -- "$script_dir/../.." && pwd)
export FAKE_RIBBONFISH_SOURCE_DIR
export FAKE_RIBBONFISH_COMMIT=128b052157f2b3c0d80e282eb1f7ab982ccb9411
cat > "$temp_dir/bin/curl" <<'EOF'
#!/bin/sh
output_file=
url=
while [ "$#" -gt 0 ]; do
	case "$1" in
		-o)
			output_file=$2
			shift 2
			;;
		-*) shift ;;
		*) url=$1; shift ;;
	esac
done
case "$url" in
	*api.github.test*)
		printf '{"sha":"%s"}\n' "$FAKE_RIBBONFISH_COMMIT"
		;;
	*"$FAKE_RIBBONFISH_COMMIT/examples/raspberry-pi/"*)
		file=${url##*/raspberry-pi/}
		cp "$FAKE_RIBBONFISH_SOURCE_DIR/examples/raspberry-pi/$file" "$output_file"
		;;
	*) echo "unexpected installer URL: $url" >&2; exit 2 ;;
esac
EOF
chmod +x "$temp_dir/bin/curl"
RIBBONFISH_GITHUB_API_URL=https://api.github.test/commits/main \
	RIBBONFISH_RAW_BASE_URL=https://raw.github.test/CyanAutomation/ribbonfish \
	TMPDIR="$temp_dir" \
	PATH="$temp_dir/bin:$PATH" sh "$script_dir/install.sh" \
	--target "$install_target" --profile pi3a-plus --drm-device /dev/null --drm-gid 0
test -f "$install_target/docker-compose.yaml"
test -x "$install_target/install.sh"
test -f "$install_target/verify-deployment.sh"
if grep -q '^RIBBONFISH_VERSION=' "$install_target/.env"; then
	echo 'installer generated an image-version setting' >&2
	exit 1
fi
test -z "$(find "$temp_dir" -maxdepth 1 -name 'ribbonfish-install.*' -print -quit)"

printf '%s\n' 'prepare-deployment tests passed'
