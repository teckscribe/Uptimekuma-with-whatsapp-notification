#!/bin/sh
mkdir -p /app/data
chown -R 1000:1000 /app/data 2>/dev/null || true
exec gosu 1000 "$@"
