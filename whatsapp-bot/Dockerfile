FROM node:20-bookworm-slim

# gosu: drop to UID 1000 after the entrypoint fixes bind-mount ownership.
RUN apt-get update && apt-get install -y --no-install-recommends     gosu ca-certificates &&     rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /app/auth /app/config && chown -R 1000:1000 /app

COPY --chown=1000:1000 package*.json ./
# Optional deps are media codecs (sharp, jimp, audio); text alerts need none.
RUN npm ci --omit=dev --omit=optional

COPY --chown=1000:1000 src ./src

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
