#!/bin/sh
# Save the pinned Uptime Kuma image to a file, so the exact release can be
# loaded on any machine even if the tag is later removed from Docker Hub.
#
# Keep the output with your backups — it is ~150MB and deliberately NOT
# committed to git (GitHub rejects files over 100MB).
#
# Usage:  ./scripts/save-image.sh

set -eu
cd "$(dirname "$0")/.."

IMAGE="$(docker compose config --images 2>/dev/null | grep uptime-kuma || echo louislam/uptime-kuma:2.0.2)"
TAG="${IMAGE##*:}"
OUT="images/uptime-kuma-$TAG.tar.gz"

mkdir -p images
echo "⬇  Ensuring $IMAGE is present locally..."
docker pull "$IMAGE" >/dev/null

echo "💾 Saving to $OUT (this takes a minute)..."
docker save "$IMAGE" | gzip > "$OUT"

echo "✅ Saved: $OUT ($(du -h "$OUT" | cut -f1))"
echo "   Copy this file alongside your docker-stack backups."
