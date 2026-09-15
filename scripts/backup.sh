#!/bin/sh
# Back up everything needed to rebuild this stack on another machine:
#   - uptime-kuma-data/   monitors, notification configs (email/WhatsApp), users, settings
#   - whatsapp-bot/config/host_map.json   site -> phone routing
#   - .env                webhook token
#
# NOT included, on purpose:
#   - whatsapp-bot/wwebjs_auth/   the WhatsApp session is a linked *device*.
#     Restoring it on a second machine makes two hosts fight over one device
#     and WhatsApp logs one out. Scan a fresh QR on each machine instead.
#
# Uptime Kuma is stopped for the few seconds it takes to copy its SQLite
# database, so the -wal / -shm journal files are consistent with kuma.db.
# Copying the database while Kuma is writing to it can lose recent changes.
#
# Usage:  ./scripts/backup.sh [output-dir]      (default: ./backups)

set -eu

cd "$(dirname "$0")/.."
OUT_DIR="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/docker-stack-backup-$STAMP.tar.gz"

mkdir -p "$OUT_DIR"

echo "⏸  Stopping uptime-kuma for a consistent database copy..."
docker compose stop uptime-kuma >/dev/null

# Always restart Kuma, even if tar fails.
trap 'echo "▶  Starting uptime-kuma..."; docker compose start uptime-kuma >/dev/null' EXIT

tar -czf "$ARCHIVE" \
  --exclude='uptime-kuma-data/screenshots' \
  --exclude='uptime-kuma-data/*.log' \
  uptime-kuma-data \
  whatsapp-bot/config/host_map.json \
  .env

echo "✅ Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "   Contains: Kuma monitors + notifications + users, host_map.json, .env"
