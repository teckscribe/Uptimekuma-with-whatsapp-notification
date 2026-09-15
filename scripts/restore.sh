#!/bin/sh
# Restore a backup made by scripts/backup.sh onto this machine.
#
# Safe to run on a fresh clone before the stack has ever started, or on a
# running stack (Kuma is stopped for the swap and restarted after). Whatever
# data is currently in place is moved aside with a timestamp, never deleted.
#
# After restoring, log in to Uptime Kuma with the credentials from the
# ORIGINAL machine — the user table is part of the backup.
#
# Usage:  ./scripts/restore.sh <backup.tar.gz>

set -eu

cd "$(dirname "$0")/.."

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 <backup.tar.gz>" >&2
  exit 1
fi
case "$ARCHIVE" in /*) ;; *) ARCHIVE="$(pwd)/$ARCHIVE" ;; esac

STAMP="$(date +%Y%m%d-%H%M%S)"

# Stop Kuma only if the stack exists here; on a fresh clone there is nothing to stop.
KUMA_RUNNING=0
if docker compose ps --services --status running 2>/dev/null | grep -qx uptime-kuma; then
  echo "⏸  Stopping uptime-kuma..."
  docker compose stop uptime-kuma >/dev/null
  KUMA_RUNNING=1
fi

# Move anything already present out of the way rather than overwriting it.
for p in uptime-kuma-data whatsapp-bot/config/host_map.json .env; do
  if [ -e "$p" ]; then
    mv "$p" "$p.before-restore-$STAMP"
    echo "↪  Existing $p moved to $p.before-restore-$STAMP"
  fi
done

echo "📦 Extracting $ARCHIVE..."
tar -xzf "$ARCHIVE"

# Kuma and the bot run as UID 1000 inside their containers.
if command -v chown >/dev/null; then
  chown -R 1000:1000 uptime-kuma-data whatsapp-bot/config 2>/dev/null || \
    sudo chown -R 1000:1000 uptime-kuma-data whatsapp-bot/config
fi

if [ "$KUMA_RUNNING" = 1 ]; then
  echo "▶  Starting uptime-kuma..."
  docker compose start uptime-kuma >/dev/null
  echo "✅ Restored. Monitors, notifications and users are back; the bot reloads host_map.json on its own."
else
  echo "✅ Restored. Now start the stack:  docker compose up -d --build"
fi
