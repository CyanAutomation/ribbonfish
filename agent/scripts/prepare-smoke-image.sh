#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: prepare-smoke-image.sh <platform> <image> [build-context]" >&2
  exit 2
fi

platform=$1
image=$2
context=${3:-}

if [ -n "$context" ]; then
  docker buildx build --platform "$platform" --load --tag "$image" "$context"
else
  docker pull --platform "$platform" "$image"
fi
