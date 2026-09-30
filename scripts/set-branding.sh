#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
NAME="${1:-Host Uptime Monitor}"
DB_PATH="${2:-uptime-kuma-data/kuma.db}"

if command -v python3 >/dev/null 2>&1; then
    python3 scripts/set-branding.py "$NAME" "$DB_PATH"
else
    python scripts/set-branding.py "$NAME" "$DB_PATH"
fi
