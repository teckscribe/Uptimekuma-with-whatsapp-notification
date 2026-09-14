#!/bin/sh
if [ ! -f /app/host_map.json ] && [ -f /app/host_map.example.json ]; then
    cp /app/host_map.example.json /app/host_map.json
fi
mkdir -p /app/wwebjs_auth
chown -R 1000:1000 /app/wwebjs_auth /app/host_map.json 2>/dev/null || true
exec gosu 1000 "$@"
