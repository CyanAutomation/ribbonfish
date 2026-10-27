#!/bin/sh
set -eu

repository=CyanAutomation/ribbonfish
api_url=${RIBBONFISH_GITHUB_API_URL:-"https://api.github.com/repos/$repository/commits/main"}
raw_base_url=${RIBBONFISH_RAW_BASE_URL:-"https://raw.githubusercontent.com/$repository"}

usage() {
	cat <<'EOF'
Usage: install.sh [prepare-deployment.sh options]

Download the current main-branch Raspberry Pi deployment kit and stage it in
~/containers/ribbonfish without cloning the repository. Requires curl and
outbound HTTPS access to api.github.com and raw.githubusercontent.com.

Options are passed to prepare-deployment.sh. Use --target, --profile,
--drm-device, --drm-gid, --sync-url, --device-id, --image,
--fix-target-owner, or --replace-env. The deployment defaults to the latest
published image; pass --image to pin an immutable tag or digest.
EOF
}

fail() {
	printf 'ribbonfish install: %s\n' "$*" >&2
	exit 1
}

case "${1:-}" in
	-h|--help)
		usage
		exit 0
		;;
esac

command -v curl >/dev/null 2>&1 || fail 'curl is required to download the deployment kit'

commit_response=$(curl -fsSL "$api_url") || fail 'could not read the current main commit from GitHub'
commit=$(printf '%s\n' "$commit_response" | awk -F '"' '$2 == "sha" && length($4) == 40 && $4 ~ /^[0-9a-f]+$/ { print $4; exit }')
case "$commit" in
	????????????????????????????????????????) ;;
	*) fail 'GitHub did not return a valid main commit SHA' ;;
esac

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/ribbonfish-install.XXXXXX") || fail 'could not create a temporary directory'
cleanup() {
	rm -rf "$temp_dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

source_dir="$temp_dir/examples/raspberry-pi"
mkdir -p "$source_dir"
for file in docker-compose.yaml docker-compose.published.yaml .env.example .gitignore README.md install.sh prepare-deployment.sh verify-deployment.sh; do
	url="$raw_base_url/$commit/examples/raspberry-pi/$file"
	curl -fsSL "$url" -o "$source_dir/$file" || fail "could not download $file from commit $commit"
done

sh "$source_dir/prepare-deployment.sh" "$@"
