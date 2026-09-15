FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    chromium \
    gosu \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

RUN mkdir -p /app/wwebjs_auth && chown -R 1000:1000 /app

COPY --chown=1000:1000 package*.json ./
RUN npm ci --omit=dev

COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 host_map*.json ./

EXPOSE 5000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
