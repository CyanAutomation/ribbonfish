#!/bin/sh
set -eu

platform=${1:?usage: smoke-container.sh <linux/arm/v7|linux/arm64> <pi3b|pi4>}
profile=${2:?usage: smoke-container.sh <linux/arm/v7|linux/arm64> <pi3b|pi4>}
case "$platform:$profile" in
  linux/arm/v7:pi3b|linux/arm64:pi4) ;;
  *) echo "unsupported platform/profile pair: $platform:$profile" >&2; exit 2 ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image="ribbonfish-agent:smoke-${profile}"
container="ribbonfish-agent-smoke-${profile}-$$"
scratch=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

mkdir -p "$scratch/cache" "$scratch/frames"
chmod 0777 "$scratch/cache" "$scratch/frames"

if [ "$profile" = pi3b ]; then
  displays='[{"id":"display-main","playlist_id":"main","rotation_interval":"1h"}]'
  playlists='[{"id":"main","assets":[{"path":"/assets/operations-overview.png"}]}]'
  expected_frames='display-main'
else
  displays='[{"id":"display-left","playlist_id":"left","rotation_interval":"1h"},{"id":"display-right","playlist_id":"right","rotation_interval":"1h"}]'
  playlists='[{"id":"left","assets":[{"path":"/assets/operations-overview.png"}]},{"id":"right","assets":[{"path":"/assets/service-health.png"}]}]'
  expected_frames='display-left display-right'
fi

cat >"$scratch/config.json" <<EOF
{
  "version": 1,
  "log_level": "info",
  "cache": {"directory": "/cache", "max_bytes": 52428800},
  "output": {"directory": "/frames"},
  "playlists": $playlists,
  "displays": $displays
}
EOF

docker buildx build --platform "$platform" --load --tag "$image" "$repo_root/agent"
docker run --detach --platform "$platform" --name "$container" \
  --mount "type=bind,src=$scratch/config.json,dst=/config.json,readonly" \
  --mount "type=bind,src=$repo_root/examples/agent/simulator/assets,dst=/assets,readonly" \
  --mount "type=bind,src=$scratch/cache,dst=/cache" \
  --mount "type=bind,src=$scratch/frames,dst=/frames" \
  "$image" -config /config.json >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  ready=true
  for display_id in $expected_frames; do
    if [ ! -s "$scratch/frames/$display_id.png" ]; then
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
  echo "ARM agent did not shut down cleanly (exit code $exit_code)" >&2
  exit 1
fi

echo "ARM container smoke check passed: $platform ($profile)"
