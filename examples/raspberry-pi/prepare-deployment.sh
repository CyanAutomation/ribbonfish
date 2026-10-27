#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=${RIBBONFISH_DEPLOYMENT_DIR:-"$HOME/containers/ribbonfish"}
profile=${RIBBONFISH_PROFILE:-}
drm_device=${RIBBONFISH_DRM_DEVICE:-}
drm_gid=${RIBBONFISH_DRM_GID:-}
sync_url=${RIBBONFISH_SYNC_URL:-}
device_id=${RIBBONFISH_DEVICE_ID:-}
replace_env=false

usage() {
	cat <<'EOF'
Usage: prepare-deployment.sh [options]

Stage the hardware Compose deployment in ~/containers/ribbonfish by default.
The Compose file always uses the latest published image and starts with
networking disabled.

Options:
  --target DIR          Deployment directory (default: ~/containers/ribbonfish)
  --profile PROFILE     pi3a-plus, pi3b, or pi4 (auto-detected where possible)
  --drm-device PATH     DRM card device (default follows the profile)
  --drm-gid GID         Numeric group owning the DRM card (default: detected)
  --sync-url URL        Cloudflare Worker URL (requires --device-id)
  --device-id ID        Stable Worker device ID (requires --sync-url)
  --replace-env         Back up and replace an existing .env
  -h, --help            Show this help

Existing .env files are preserved.
EOF
}

fail() {
	printf 'prepare-deployment: %s\n' "$*" >&2
	exit 1
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--target)
			[ "$#" -ge 2 ] || fail '--target requires a directory'
			target_dir=$2
			shift 2
			;;
		--profile)
			[ "$#" -ge 2 ] || fail '--profile requires a value'
			profile=$2
			shift 2
			;;
		--drm-device)
			[ "$#" -ge 2 ] || fail '--drm-device requires a path'
			drm_device=$2
			shift 2
			;;
		--drm-gid)
			[ "$#" -ge 2 ] || fail '--drm-gid requires a value'
			drm_gid=$2
			shift 2
			;;
		--sync-url)
			[ "$#" -ge 2 ] || fail '--sync-url requires a URL'
			sync_url=$2
			shift 2
			;;
		--device-id)
			[ "$#" -ge 2 ] || fail '--device-id requires a value'
			device_id=$2
			shift 2
			;;
		--replace-env)
			replace_env=true
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			fail "unknown option: $1"
			;;
	esac
done

if [ -z "$profile" ]; then
	model=$(tr -d '\000' </proc/device-tree/model 2>/dev/null || true)
	case "$model" in
		*"Raspberry Pi 3 Model A Plus"*) profile=pi3a-plus ;;
		*"Raspberry Pi 3 Model B"*) profile=pi3b ;;
		*"Raspberry Pi 4"*) profile=pi4 ;;
		*) fail 'could not detect a supported Pi profile; pass --profile pi3a-plus, pi3b, or pi4' ;;
	esac
fi

case "$profile" in
	pi3a-plus|pi3b) default_device=/dev/dri/card0 ;;
	pi4) default_device=/dev/dri/card1 ;;
	*) fail "unsupported Pi profile '$profile' (choose pi3a-plus, pi3b, or pi4)" ;;
esac

drm_device=${drm_device:-$default_device}
[ -c "$drm_device" ] || fail "DRM device '$drm_device' is not a character device; inspect /dev/dri and pass --drm-device"

device_gid=$(stat -c '%g' "$drm_device" 2>/dev/null || stat -f '%g' "$drm_device" 2>/dev/null || true)
case "$device_gid" in
	''|*[!0-9]*) fail "could not read the numeric group for '$drm_device'" ;;
esac
drm_gid=${drm_gid:-$device_gid}
case "$drm_gid" in
	''|*[!0-9]*) fail "DRM group '$drm_gid' must be numeric" ;;
esac
[ "$drm_gid" = "$device_gid" ] || fail "DRM GID $drm_gid does not own '$drm_device' (actual GID: $device_gid)"

if [ -n "$sync_url" ] && [ -z "$device_id" ]; then
	fail '--device-id is required when --sync-url is set'
fi
if [ -n "$device_id" ] && [ -z "$sync_url" ]; then
	fail '--sync-url is required when --device-id is set'
fi

if [ -n "$sync_url" ]; then
	case "$sync_url" in
		https://*) ;;
		*) fail '--sync-url must use HTTPS' ;;
	esac
fi

if [ -n "$device_id" ]; then
	case "$device_id" in
		[A-Za-z0-9]*) ;;
		*) fail '--device-id must start with a letter or digit' ;;
	esac
	case "$device_id" in
		*[!A-Za-z0-9._-]*) fail '--device-id may contain only letters, digits, dot, underscore, and hyphen' ;;
	esac
	[ "${#device_id}" -le 64 ] || fail '--device-id must be at most 64 characters'
fi

if [ -e "$target_dir" ]; then
	[ -d "$target_dir" ] || fail "deployment target '$target_dir' exists and is not a directory"
	[ -w "$target_dir" ] || fail "deployment target '$target_dir' is not writable; make it owned by $(id -un) or choose --target DIR"
else
	parent_dir=$(dirname -- "$target_dir")
	while [ ! -d "$parent_dir" ]; do
		parent_dir=$(dirname -- "$parent_dir")
	done
	[ -w "$parent_dir" ] || fail "parent directory '$parent_dir' is not writable; make the deployment path user-writable or choose --target DIR"
fi

mkdir -p "$target_dir"

stage_file() {
	source=$1
	name=$2
	temporary="$target_dir/.$name.$$"
	cp "$source" "$temporary"
	mv -f "$temporary" "$target_dir/$name"
}

stage_file "$script_dir/docker-compose.yaml" docker-compose.yaml
stage_file "$script_dir/.env.example" .env.example
stage_file "$script_dir/.gitignore" .gitignore
stage_file "$script_dir/README.md" README.md
stage_file "$script_dir/install.sh" install.sh
stage_file "$script_dir/prepare-deployment.sh" prepare-deployment.sh
stage_file "$script_dir/verify-deployment.sh" verify-deployment.sh
chmod 0755 "$target_dir/install.sh" "$target_dir/prepare-deployment.sh" "$target_dir/verify-deployment.sh"

if [ -e "$target_dir/.env" ] && [ "$replace_env" = true ]; then
	backup="$target_dir/.env.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
	cp "$target_dir/.env" "$backup"
	chmod 0600 "$backup"
	printf 'Backed up existing environment to %s\n' "$backup"
fi

if [ ! -e "$target_dir/.env" ] || [ "$replace_env" = true ]; then
	umask 077
	environment_tmp="$target_dir/.env.$$"
	if [ -n "$sync_url" ]; then
		network_mode=bridge
	else
		network_mode=none
	fi
	cat >"$environment_tmp" <<EOF
RIBBONFISH_PROFILE=$profile
RIBBONFISH_DRM_DEVICE=$drm_device
RIBBONFISH_DRM_GID=$drm_gid
RIBBONFISH_NETWORK_MODE=$network_mode
EOF
	if [ -n "$sync_url" ]; then
		printf 'RIBBONFISH_SYNC_URL=%s\nRIBBONFISH_DEVICE_ID=%s\n' "$sync_url" "$device_id" >>"$environment_tmp"
	fi
	chmod 0600 "$environment_tmp"
	mv -f "$environment_tmp" "$target_dir/.env"
	printf 'Created %s/.env with profile %s, image latest, and network mode %s\n' "$target_dir" "$profile" "$network_mode"
else
	printf 'Preserved existing %s/.env; validate it with verify-deployment.sh\n' "$target_dir"
fi

printf 'Prepared Ribbonfish deployment in %s\n' "$target_dir"
printf 'Run: cd %s && ./verify-deployment.sh --preflight\n' "$target_dir"
