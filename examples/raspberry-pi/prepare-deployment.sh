#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=${1:-"$HOME/containers/ribbonfish"}

set -- "$script_dir"/hardware-config.*.json
if [ ! -f "$1" ]; then
	printf 'No hardware configuration profiles found in %s\n' "$script_dir" >&2
	exit 1
fi

mkdir -p "$target_dir" "$target_dir/assets"
cp "$script_dir/docker-compose.yaml" "$target_dir/docker-compose.yaml"
cp "$script_dir/.env.example" "$target_dir/.env.example"
cp -n "$script_dir/.gitignore" "$target_dir/.gitignore"
cp -n "$@" "$target_dir/"
cp -an "$script_dir"/assets/. "$target_dir/assets/"

if [ ! -e "$target_dir/.env" ]; then
	cp "$script_dir/.env.example" "$target_dir/.env"
fi

printf 'Prepared Ribbonfish deployment in %s\n' "$target_dir"
printf 'Review %s/.env, then run docker compose up -d from that directory.\n' "$target_dir"
