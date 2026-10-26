#!/bin/sh
set -eu

# Contract source: agent/README.md#arm-container-compatibility.

platform=${1:?usage: smoke-container.sh <linux/amd64|linux/arm/v7|linux/arm64> <pi3b|pi4>}
profile=${2:?usage: smoke-container.sh <linux/amd64|linux/arm/v7|linux/arm64> <pi3b|pi4>}
case "$platform:$profile" in
	linux/arm/v7:pi3b|linux/arm64:pi4|linux/amd64:pi3b|linux/amd64:pi4) ;;
  *) echo "unsupported platform/profile pair: $platform:$profile" >&2; exit 2 ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image="ribbonfish:smoke-${profile}"
container="ribbonfish-smoke-${profile}-$$"
cache_volume="ribbonfish-smoke-cache-${profile}-$$"
scratch=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$cache_volume" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

frame_update_logged() {
  printf '%s\n' "$1" \
    | grep -F 'msg="display frame updated"' \
    | grep -F "display_id=$2" \
    | grep -F "asset_sha256=$3" >/dev/null
}

frame_update_for_display() {
  display_id=$1
  for asset_sha in $playlist_shas; do
    if frame_update_logged "$container_logs" "$display_id" "$asset_sha"; then
      return 0
    fi
  done
  return 1
}

mkdir -p "$scratch/frames" "$scratch/offline-frames"

if [ "$profile" = pi3b ]; then
	default_profile=simulator-pi3b
  expected_frames='display-main'
else
	default_profile=simulator-pi4
  expected_frames='display-left display-right'
fi

playlist_shas=$(python3 -c 'import json,sys; print(" ".join(asset["sha256"] for asset in json.load(open(sys.argv[1]))["playlist"]["assets"]))' \
  "$repo_root/agent/defaults/$default_profile.json")
[ -n "$playlist_shas" ] || { echo "default playlist is empty: $default_profile" >&2; exit 1; }

docker buildx build --platform "$platform" --load --tag "$image" "$repo_root/agent"
docker volume create "$cache_volume" >/dev/null
docker run --detach --platform "$platform" --name "$container" \
	  --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
	  --user 65532:65532 \
  --env "RIBBONFISH_PROFILE=$default_profile" \
  --mount "type=volume,src=$cache_volume,dst=/var/lib/ribbonfish" \
  "$image" >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  # docker cp writes files as the invoking host user, so owner-only frames
  # produced by the non-root container remain inspectable without loosening
  # the simulator's output permissions.
  docker cp "$container:/var/lib/ribbonfish/frames/." "$scratch/frames/" >/dev/null 2>&1 || true
  container_logs=$(docker logs "$container" 2>&1 || true)
  ready=true
  for display_id in $expected_frames; do
    if [ ! -s "$scratch/frames/$display_id.png" ] || ! frame_update_for_display "$display_id"; then
      ready=false
      break
    fi
  done
  [ "$ready" = true ] && break
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    docker logs "$container" >&2 || true
    echo "ARM agent container exited before writing display frames" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$ready" != true ]; then
  docker logs "$container" >&2 || true
  echo "timed out waiting for simulated frames" >&2
  exit 1
fi

for display_id in $expected_frames; do
  signature=$(od -An -tx1 -N8 "$scratch/frames/$display_id.png" | tr -d ' \n')
  if [ "$signature" != 89504e470d0a1a0a ]; then
    echo "invalid PNG output for $display_id: $signature" >&2
    exit 1
  fi
done

if [ "$profile" = pi4 ] && ! cmp -s "$scratch/frames/display-left.png" "$scratch/frames/display-right.png"; then
	echo "dual-display profile did not show the same active playlist on both outputs" >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
  docker logs "$container" >&2 || true
  echo "ARM agent container stopped after writing its first frames" >&2
  exit 1
fi
docker stop --time 5 "$container" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$container")
if [ "$exit_code" != 0 ]; then
  docker logs "$container" >&2 || true
  echo "ARM agent exited with code $exit_code (unexpected exit or failed graceful shutdown)" >&2
  exit 1
fi

docker rm "$container" >/dev/null
docker run --detach --platform "$platform" --name "$container" \
	  --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
	  --user 65532:65532 \
  --env "RIBBONFISH_PROFILE=$default_profile" \
  --mount "type=volume,src=$cache_volume,dst=/var/lib/ribbonfish" \
  "$image" >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  docker cp "$container:/var/lib/ribbonfish/frames/." "$scratch/offline-frames/" >/dev/null 2>&1 || true
  container_logs=$(docker logs "$container" 2>&1 || true)
  ready=true
  for display_id in $expected_frames; do
    if [ ! -s "$scratch/offline-frames/$display_id.png" ] || ! frame_update_for_display "$display_id"; then
      ready=false
      break
    fi
  done
  if [ "$ready" = true ]; then
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
    docker logs "$container" >&2 || true
    echo "agent could not restart from its persistent cache without source assets" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$ready" != true ]; then
  docker logs "$container" >&2 || true
  echo "timed out waiting for cached frames after an offline restart" >&2
  exit 1
fi

if [ "$profile" = pi4 ] && ! cmp -s "$scratch/offline-frames/display-left.png" "$scratch/offline-frames/display-right.png"; then
	echo "offline dual-display profile did not restore the shared active playlist" >&2
  exit 1
fi

docker stop --time 5 "$container" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$container")
if [ "$exit_code" != 0 ]; then
  docker logs "$container" >&2 || true
  echo "ARM agent offline restart exited with code $exit_code during shutdown" >&2
  exit 1
fi

echo "Container smoke check passed: $platform ($profile)"
