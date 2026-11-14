#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir -p "$scratch/bin"
cat > "$scratch/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$DOCKER_CALLS"
EOF
chmod +x "$scratch/bin/docker"

DOCKER_CALLS="$scratch/calls" PATH="$scratch/bin:$PATH" \
  sh "$repo_root/agent/scripts/prepare-smoke-image.sh" linux/arm/v7 example:sha-123
grep -Fx 'pull --platform linux/arm/v7 example:sha-123' "$scratch/calls" >/dev/null

: > "$scratch/calls"
DOCKER_CALLS="$scratch/calls" PATH="$scratch/bin:$PATH" \
  sh "$repo_root/agent/scripts/prepare-smoke-image.sh" linux/arm64 example:local "$repo_root/agent"
grep -Fx "buildx build --platform linux/arm64 --load --tag example:local $repo_root/agent" "$scratch/calls" >/dev/null

echo 'Smoke image preparation tests passed.'
