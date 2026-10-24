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
image="ribbonfish-agent:smoke-${profile}"
container="ribbonfish-agent-smoke-${profile}-$$"
cache_volume="ribbonfish-agent-smoke-cache-${profile}-$$"
frames_volume="ribbonfish-agent-smoke-frames-${profile}-$$"
scratch=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$cache_volume" "$frames_volume" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

frame_update_logged() {
  docker logs "$container" 2>&1 \
    | grep -F 'msg="display frame updated"' \
    | grep -F "display_id=$1" \
    | grep -F "asset_sha256=$2" >/dev/null
}

mkdir -p "$scratch/frames" "$scratch/offline-frames" "$scratch/assets"
cp "$repo_root"/examples/agent/simulator/assets/*.png "$scratch/assets/"
chmod 0755 "$scratch/assets"
chmod 0644 "$scratch/assets"/*.png

if [ "$profile" = pi3b ]; then
  operations_sha=$(sha256_file "$repo_root/examples/agent/simulator/assets/operations-overview.png")
  displays='[{"id":"display-main","playlist_id":"main","rotation_interval":"1h"}]'
  playlists="[{\"id\":\"main\",\"assets\":[{\"path\":\"/assets/operations-overview.png\",\"sha256\":\"$operations_sha\"}]}]"
  expected_frames='display-main'
  expected_assets="display-main:$operations_sha"
else
  operations_sha=$(sha256_file "$repo_root/examples/agent/simulator/assets/operations-overview.png")
  health_sha=$(sha256_file "$repo_root/examples/agent/simulator/assets/service-health.png")
  displays='[{"id":"display-left","playlist_id":"left","rotation_interval":"1h"},{"id":"display-right","playlist_id":"right","rotation_interval":"1h"}]'
  playlists="[{\"id\":\"left\",\"assets\":[{\"path\":\"/assets/operations-overview.png\",\"sha256\":\"$operations_sha\"}]},{\"id\":\"right\",\"assets\":[{\"path\":\"/assets/service-health.png\",\"sha256\":\"$health_sha\"}]}]"
  expected_frames='display-left display-right'
  expected_assets="display-left:$operations_sha display-right:$health_sha"
fi

cat >"$scratch/config.json" <<EOF
{
  "version": 1,
  "log_level": "info",
  "cache": {"directory": "/var/lib/ribbonfish/cache", "max_bytes": 52428800},
  "output": {"directory": "/var/lib/ribbonfish/frames"},
  "playlists": $playlists,
  "displays": $displays
}
EOF
chmod 0644 "$scratch/config.json"

docker buildx build --platform "$platform" --load --tag "$image" "$repo_root/agent"
docker volume create "$cache_volume" >/dev/null
docker volume create "$frames_volume" >/dev/null
docker run --detach --platform "$platform" --name "$container" \
  --mount "type=bind,src=$scratch/config.json,dst=/config.json,readonly" \
  --mount "type=bind,src=$scratch/assets,dst=/assets,readonly" \
  --mount "type=volume,src=$cache_volume,dst=/var/lib/ribbonfish/cache" \
  --mount "type=volume,src=$frames_volume,dst=/var/lib/ribbonfish/frames" \
  "$image" -config /config.json >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  # docker cp writes files as the invoking host user, so owner-only frames
  # produced by the non-root container remain inspectable without loosening
  # the simulator's output permissions.
  docker cp "$container:/var/lib/ribbonfish/frames/." "$scratch/frames/" >/dev/null 2>&1 || true
  ready=true
  for asset in $expected_assets; do
    display_id=${asset%%:*}
    digest=${asset#*:}
    if [ ! -s "$scratch/frames/$display_id.png" ] || ! frame_update_logged "$display_id" "$digest"; then
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

if [ "$profile" = pi4 ] && cmp -s "$scratch/frames/display-left.png" "$scratch/frames/display-right.png"; then
  echo "dual-display profile wrote identical frames for independent playlists" >&2
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
  --mount "type=bind,src=$scratch/config.json,dst=/config.json,readonly" \
  --mount "type=volume,src=$cache_volume,dst=/var/lib/ribbonfish/cache" \
  --mount "type=volume,src=$frames_volume,dst=/var/lib/ribbonfish/frames" \
  "$image" -config /config.json >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  docker cp "$container:/var/lib/ribbonfish/frames/." "$scratch/offline-frames/" >/dev/null 2>&1 || true
  ready=true
  for asset in $expected_assets; do
    display_id=${asset%%:*}
    digest=${asset#*:}
    if [ ! -s "$scratch/offline-frames/$display_id.png" ] || ! frame_update_logged "$display_id" "$digest"; then
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

if [ "$profile" = pi4 ] && cmp -s "$scratch/offline-frames/display-left.png" "$scratch/offline-frames/display-right.png"; then
  echo "offline dual-display profile wrote identical frames for independent playlists" >&2
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
