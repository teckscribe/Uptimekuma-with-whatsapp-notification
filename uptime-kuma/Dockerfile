# ==============================================================================
# Multi-stage Dockerfile for Uptime Kuma (Standalone / Independent of 3rd party)
# ==============================================================================

# Stage 1: Build frontend
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production release
FROM node:20-bookworm-slim AS release
WORKDIR /app

ENV UPTIME_KUMA_IS_CONTAINER=1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV NODE_ENV=production

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        iputils-ping \
        curl \
        ca-certificates \
        dumb-init && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/server /app/server
COPY --from=builder /app/db /app/db
COPY --from=builder /app/src /app/src
COPY --from=builder /app/extra /app/extra
COPY --from=builder /app/index.html /app/index.html

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3001

HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.js"]
