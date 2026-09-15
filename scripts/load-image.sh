#!/bin/sh
# Load a saved Uptime Kuma image (from scripts/save-image.sh) into the local
# Docker daemon. Use this on a machine with no internet, or if the pinned tag
# is no longer available on Docker Hub. After loading, `docker compose up`
# finds the image locally and does not try to pull.
#
# Usage:  ./scripts/load-image.sh [path/to/uptime-kuma-2.0.2.tar.gz]

set -eu
cd "$(dirname "$0")/.."

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls images/uptime-kuma-*.tar.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "No saved image found. Pass the path, or run ./scripts/save-image.sh on a machine that has it." >&2
  exit 1
fi

echo "📦 Loading $FILE..."
gunzip -c "$FILE" | docker load
echo "✅ Loaded. Run:  docker compose up -d"
