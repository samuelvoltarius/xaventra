FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_audit=false npm_config_fund=false
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client iproute2 procps pciutils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY dist ./dist
COPY assets ./assets
COPY SOUL.md LICENSE THIRD_PARTY_NOTICES.md xaventra.config.example.json ./
RUN mkdir /runtime && chown node:node /runtime
USER 1000:1000
WORKDIR /runtime
ENTRYPOINT ["node", "/app/dist/daemon.js"]
