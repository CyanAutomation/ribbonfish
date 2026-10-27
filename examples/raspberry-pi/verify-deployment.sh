#!/bin/sh
set -eu

deployment_dir=${RIBBONFISH_DEPLOYMENT_DIR:-"$HOME/containers/ribbonfish"}
preflight=false

fail() {
	printf 'verify-deployment: %s\n' "$*" >&2
	exit 1
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--target)
			[ "$#" -ge 2 ] || fail '--target requires a directory'
			deployment_dir=$2
			shift 2
			;;
		--preflight)
			preflight=true
			shift
			;;
		-h|--help)
			printf 'Usage: verify-deployment.sh [--target DIR] [--preflight]\n'
			printf 'Full verification waits up to 30 seconds for startup logs by default; set RIBBONFISH_VERIFY_TIMEOUT to change it.\n'
			exit 0
			;;
		*)
			fail "unknown option: $1"
			;;
	esac
done

[ -d "$deployment_dir" ] || fail "deployment directory '$deployment_dir' does not exist"
[ -r "$deployment_dir/.env" ] || fail "missing or unreadable $deployment_dir/.env"
[ -r "$deployment_dir/docker-compose.yaml" ] || fail "missing or unreadable $deployment_dir/docker-compose.yaml"

env_value() {
	awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$deployment_dir/.env"
}

version=$(env_value RIBBONFISH_VERSION)
profile=$(env_value RIBBONFISH_PROFILE)
drm_device=$(env_value RIBBONFISH_DRM_DEVICE)
drm_gid=$(env_value RIBBONFISH_DRM_GID)
network_mode=$(env_value RIBBONFISH_NETWORK_MODE)
sync_url=$(env_value RIBBONFISH_SYNC_URL)
device_id=$(env_value RIBBONFISH_DEVICE_ID)

case "$version" in
	latest)
		;;
	sha-*) image_commit=${version#sha-} ;;
	*) fail "RIBBONFISH_VERSION='$version' must be 'latest' or a pinned sha-<40-character commit>" ;;
esac
if [ "$version" != latest ]; then
	[ "${#image_commit}" -eq 40 ] || fail "RIBBONFISH_VERSION='$version' must contain a 40-character commit SHA"
	case "$image_commit" in
		*[!0-9a-f]*) fail "RIBBONFISH_VERSION='$version' must use lowercase hexadecimal" ;;
	esac
fi
case "$profile" in
	pi3a-plus|pi3b|pi4) ;;
	*) fail "unsupported RIBBONFISH_PROFILE='$profile'" ;;
esac
[ -n "$drm_device" ] && [ -c "$drm_device" ] || fail "DRM device '$drm_device' is not a character device"
device_gid=$(stat -c '%g' "$drm_device" 2>/dev/null || stat -f '%g' "$drm_device" 2>/dev/null || true)
[ -n "$device_gid" ] && [ "$drm_gid" = "$device_gid" ] || fail "RIBBONFISH_DRM_GID='$drm_gid' does not match $drm_device group '$device_gid'"

if [ -n "$sync_url" ]; then
	[ "$network_mode" = bridge ] || fail 'Cloudflare sync requires RIBBONFISH_NETWORK_MODE=bridge'
	[ -n "$device_id" ] || fail 'Cloudflare sync requires RIBBONFISH_DEVICE_ID'
else
	[ "$network_mode" = none ] || fail 'network access is only enabled when Cloudflare sync is configured'
fi

expected_image="cyanautomation/ribbonfish:$version"
config_images=$(docker compose --project-directory "$deployment_dir" -p ribbonfish config --images) || fail 'docker compose config failed'
printf '%s\n' "$config_images" | grep -Fx "$expected_image" >/dev/null || fail "Compose resolves to '$config_images', expected '$expected_image'"
docker compose --project-directory "$deployment_dir" -p ribbonfish config --quiet || fail 'docker compose config is invalid'

if [ "$preflight" = true ]; then
	printf 'Preflight passed: profile=%s image=%s device=%s gid=%s network=%s\n' "$profile" "$expected_image" "$drm_device" "$drm_gid" "$network_mode"
	exit 0
fi

container_id=$(docker compose --project-directory "$deployment_dir" -p ribbonfish ps -q agent)
[ -n "$container_id" ] || fail 'agent container is not running; start it with docker compose up -d'
image_id=$(docker image inspect --format '{{.Id}}' "$expected_image") || fail "image '$expected_image' is not present locally"
[ -n "$image_id" ] || fail "could not resolve local image ID for '$expected_image'"
runtime=$(docker inspect --format '{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.HostConfig.NetworkMode}}' "$container_id") || fail 'could not inspect agent container'
expected_runtime="$expected_image|$image_id|running|$network_mode"
[ "$runtime" = "$expected_runtime" ] || fail "container state '$runtime' does not match '$expected_runtime'"

verify_timeout=${RIBBONFISH_VERIFY_TIMEOUT:-30}
case "$verify_timeout" in
	''|*[!0-9]*) fail 'RIBBONFISH_VERIFY_TIMEOUT must be a positive integer' ;;
esac
[ "$verify_timeout" -gt 0 ] || fail 'RIBBONFISH_VERIFY_TIMEOUT must be a positive integer'

attempt=0
while [ "$attempt" -le "$verify_timeout" ]; do
	logs=$(docker logs --tail 200 "$container_id" 2>&1) || fail 'could not read agent logs'
	if printf '%s\n' "$logs" | grep -F 'msg="agent configuration loaded"' | grep -Eq 'displays=[1-9][0-9]*'; then
		break
	fi
	attempt=$((attempt + 1))
	[ "$attempt" -gt "$verify_timeout" ] || sleep 1
done
[ "$attempt" -le "$verify_timeout" ] || fail "timed out after ${verify_timeout}s waiting for a usable display configuration"

connector_report=$(docker compose --project-directory "$deployment_dir" -p ribbonfish exec -T agent /ribbonfish -check-displays 2>&1) || fail "configured DRM connectors are unavailable or do not advertise the configured mode: $connector_report"
printf '%s\n' "$connector_report"

attempt=0
while [ "$attempt" -le "$verify_timeout" ]; do
	logs=$(docker logs --tail 200 "$container_id" 2>&1) || fail 'could not read agent logs'
	if printf '%s\n' "$logs" | grep -F 'msg="display frame updated"' >/dev/null; then
		break
	fi
	attempt=$((attempt + 1))
	[ "$attempt" -gt "$verify_timeout" ] || sleep 1
done
[ "$attempt" -le "$verify_timeout" ] || fail "timed out after ${verify_timeout}s waiting for a successful display frame update"

logs=$(docker logs --tail 200 "$container_id" 2>&1) || fail 'could not read agent logs'
printf '%s\n' "$logs" | grep -F 'msg="display frame updated"' >/dev/null || fail 'agent has not logged a successful display frame update'

printf 'Deployment verified: profile=%s image=%s status=running network=%s; DRM connectors ready and display frame updated\n' "$profile" "$expected_image" "$network_mode"
