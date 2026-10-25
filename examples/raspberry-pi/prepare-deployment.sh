#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target_dir=${1:-"$HOME/containers/ribbonfish"}

mkdir -p "$target_dir"
cp "$script_dir/docker-compose.yaml" "$target_dir/docker-compose.yaml"
cp "$script_dir/.env.example" "$target_dir/.env.example"
cp -n "$script_dir/.gitignore" "$target_dir/.gitignore"

if [ ! -e "$target_dir/.env" ]; then
	cp "$script_dir/.env.example" "$target_dir/.env"
fi

printf 'Prepared Ribbonfish deployment in %s\n' "$target_dir"
printf 'Review %s/.env, then run docker compose up -d from that directory.\n' "$target_dir"
