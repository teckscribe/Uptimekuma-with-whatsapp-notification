# ==============================================================================
# Standalone Dockerfile for Uptime Kuma v2.0.2
# Uses pre-bundled dist frontend assets for instant, reliable builds
# ==============================================================================

FROM node:20-bookworm-slim
WORKDIR /app

ENV UPTIME_KUMA_IS_CONTAINER=1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV NODE_ENV=production

# Install essential runtime tools for monitoring (ping, curl, init)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        iputils-ping \
        curl \
        ca-certificates \
        dumb-init && \
    rm -rf /var/lib/apt/lists/*

# Copy package files and .npmrc (which contains legacy-peer-deps=true)
COPY .npmrc package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy application assets and pre-bundled frontend dist
COPY . .

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3001

HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3001/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server/server.js"]
