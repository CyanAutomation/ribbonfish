#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=${RIBBONFISH_DEPLOYMENT_DIR:-"$HOME/containers/ribbonfish"}
profile=${RIBBONFISH_PROFILE:-}
drm_device=${RIBBONFISH_DRM_DEVICE:-}
drm_gid=${RIBBONFISH_DRM_GID:-}
sync_url=${RIBBONFISH_SYNC_URL:-}
device_id=${RIBBONFISH_DEVICE_ID:-}
image=${RIBBONFISH_IMAGE:-}
replace_env=false
fix_target_owner=false

usage() {
	cat <<'EOF'
Usage: prepare-deployment.sh [options]

Stage the hardware Compose deployment in ~/containers/ribbonfish by default.
The Compose file defaults to the latest published image and starts with
networking disabled. Use --image to select an immutable tag or digest.

Options:
  --target DIR          Deployment directory (default: ~/containers/ribbonfish)
  --profile PROFILE     pi3a-plus, pi3b, pi4, or pi4-single (auto-detected where possible)
  --drm-device PATH     DRM device (Pi 4 defaults to its stable KMS alias)
  --drm-gid GID         Numeric group owning the DRM card (default: detected)
  --sync-url URL        Cloudflare Worker URL (requires --device-id)
  --device-id ID        Stable Worker device ID (requires --sync-url)
  --image IMAGE         image tag or digest (default: cyanautomation/ribbonfish:latest)
  --fix-target-owner    use sudo to fix an empty root-owned target directory
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
		--image)
			[ "$#" -ge 2 ] || fail '--image requires an image reference'
			[ -n "$2" ] || fail '--image requires a nonempty image reference'
			image=$2
			shift 2
			;;
		--fix-target-owner)
			fix_target_owner=true
			shift
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

if [ -n "$image" ]; then
	case "$image" in
		*[!A-Za-z0-9._/:@+-]*) fail '--image contains characters that are not valid in a Docker image reference' ;;
	esac
fi

if [ -z "$profile" ]; then
	model=$(tr -d '\000' </proc/device-tree/model 2>/dev/null || true)
	case "$model" in
		*"Raspberry Pi 3 Model A Plus"*) profile=pi3a-plus ;;
		*"Raspberry Pi 3 Model B"*) profile=pi3b ;;
		*"Raspberry Pi 4"*) profile=pi4 ;;
		*) fail 'could not detect a supported Pi profile; pass --profile pi3a-plus, pi3b, pi4, or pi4-single' ;;
	esac
fi

case "$profile" in
	pi3a-plus|pi3b) default_device=/dev/dri/card0 ;;
	pi4) default_device=/dev/dri/by-path/platform-gpu-card ;;
	pi4-single) default_device=/dev/dri/by-path/platform-gpu-card ;;
	*) fail "unsupported Pi profile '$profile' (choose pi3a-plus, pi3b, pi4, or pi4-single)" ;;
esac

drm_device=${drm_device:-$default_device}
[ -c "$drm_device" ] || fail "DRM device '$drm_device' is not a character device; inspect /dev/dri and pass --drm-device"

device_gid=$(stat -L -c '%g' "$drm_device" 2>/dev/null || stat -L -f '%g' "$drm_device" 2>/dev/null || true)
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
	if [ ! -w "$target_dir" ]; then
		[ "$fix_target_owner" = true ] || fail "deployment target '$target_dir' is not writable; if it is empty and root-owned, rerun with --fix-target-owner, or choose --target DIR"
		[ ! -L "$target_dir" ] || fail "--fix-target-owner cannot repair a symlink target"
		for entry in "$target_dir"/* "$target_dir"/.[!.]* "$target_dir"/..?*; do
			if [ -e "$entry" ] || [ -L "$entry" ]; then
				fail "--fix-target-owner only repairs an empty root-owned target; '$target_dir' contains files"
			fi
		done
		target_owner=$(stat -c '%u' "$target_dir" 2>/dev/null || stat -f '%u' "$target_dir" 2>/dev/null || true)
		[ "$target_owner" = 0 ] || fail "--fix-target-owner only repairs an empty root-owned target; '$target_dir' is owned by UID ${target_owner:-unknown}"
		command -v sudo >/dev/null 2>&1 || fail 'sudo is required to fix the root-owned deployment target'
		sudo chown "$(id -u):$(id -g)" "$target_dir" || fail "could not change ownership of '$target_dir'"
		[ -w "$target_dir" ] || fail "deployment target '$target_dir' is still not writable after ownership repair"
		printf 'Changed ownership of empty deployment directory %s to %s\n' "$target_dir" "$(id -un)"
	fi
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
stage_file "$script_dir/docker-compose.published.yaml" docker-compose.published.yaml
stage_file "$script_dir/.env.example" .env.example
stage_file "$script_dir/.gitignore" .gitignore
stage_file "$script_dir/README.md" README.md
stage_file "$script_dir/install.sh" install.sh
stage_file "$script_dir/prepare-deployment.sh" prepare-deployment.sh
stage_file "$script_dir/verify-deployment.sh" verify-deployment.sh
chmod 0755 "$target_dir/install.sh" "$target_dir/prepare-deployment.sh" "$target_dir/verify-deployment.sh"

backup_env() {
	backup="$target_dir/.env.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
	cp "$target_dir/.env" "$backup"
	chmod 0600 "$backup"
	printf 'Backed up existing environment to %s\n' "$backup"
}

if [ -e "$target_dir/.env" ] && [ "$replace_env" = true ]; then
	backup_env
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
	if [ -n "$image" ]; then
		printf 'RIBBONFISH_IMAGE=%s\n' "$image" >>"$environment_tmp"
	fi
	if [ -n "$sync_url" ]; then
		printf 'RIBBONFISH_SYNC_URL=%s\nRIBBONFISH_DEVICE_ID=%s\n' "$sync_url" "$device_id" >>"$environment_tmp"
	fi
	chmod 0600 "$environment_tmp"
	mv -f "$environment_tmp" "$target_dir/.env"
	printf 'Created %s/.env with profile %s, image %s, and network mode %s\n' "$target_dir" "$profile" "${image:-cyanautomation/ribbonfish:latest}" "$network_mode"
else
	printf 'Preserved existing %s/.env; validate it with verify-deployment.sh\n' "$target_dir"
fi

if [ -e "$target_dir/.env" ] && [ "$replace_env" != true ] && [ -n "$image" ]; then
	existing_image=$(awk -F= '$1 == "RIBBONFISH_IMAGE" { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$target_dir/.env")
	if [ "$existing_image" != "$image" ]; then
		backup_env
		environment_tmp="$target_dir/.env.$$"
		awk -F= -v image="$image" '
			BEGIN { written = 0 }
			$1 == "RIBBONFISH_IMAGE" {
				if (!written) print "RIBBONFISH_IMAGE=" image
				written = 1
				next
			}
			{ print }
			END { if (!written) print "RIBBONFISH_IMAGE=" image }
		' "$target_dir/.env" >"$environment_tmp"
		chmod 0600 "$environment_tmp"
		mv -f "$environment_tmp" "$target_dir/.env"
		printf 'Updated image reference in %s/.env to %s\n' "$target_dir" "$image"
	fi
fi

printf 'Prepared Ribbonfish deployment in %s\n' "$target_dir"
printf 'Run: cd %s && docker compose -p ribbonfish pull && ./verify-deployment.sh --preflight\n' "$target_dir"
