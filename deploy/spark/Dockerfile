FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client iproute2 procps pciutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
RUN mkdir -p /app/.agent/skills /app/.nova-logs \
    && chown -R node:node /app

USER node
CMD ["node", "dist/daemon.js"]
