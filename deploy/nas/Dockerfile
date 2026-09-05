FROM node:22-bookworm-slim

ARG NOVA_VERSION=unknown

LABEL org.opencontainers.image.title="Nova NAS Worker" \
      org.opencontainers.image.version="${NOVA_VERSION}"

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    HOME=/app/.home

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl iproute2 procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY dist ./dist

RUN mkdir -p /app/.nova-data /app/.nova-memory /app/.nova-learning \
        /app/.nova-vector-memory /app/.nova-logs /app/.nova-costs \
        /app/.agent /app/.home \
    && chown -R node:node /app \
    && chmod -R a+rX /app/dist /app/node_modules /app/package.json /app/package-lock.json

USER node
CMD ["node", "dist/daemon.js"]
