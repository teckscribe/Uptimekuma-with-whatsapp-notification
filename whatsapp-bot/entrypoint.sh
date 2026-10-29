#!/bin/sh
# Bind mounts may arrive root-owned (Docker creates missing host dirs as root).
chown -R 1000:1000 /app/auth /app/config 2>/dev/null || true
exec gosu 1000 "$@"
