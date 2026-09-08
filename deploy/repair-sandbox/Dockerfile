# Build from reviewed manifests in a dedicated secret-free context.
# Pin the base digest in the operator's image build/release process.
FROM node:22-bookworm-slim
# Publisher regressions create isolated Git source mirrors. Install the actual
# client in the trusted dependency image; tests are not skipped in confinement.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sandbox
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
ARG LOCK_SHA256
LABEL org.xaventra.sandbox.lock-sha256=$LOCK_SHA256
ARG DEPENDENCIES_SHA256
LABEL org.xaventra.sandbox.dependencies-sha256=$DEPENDENCIES_SHA256
USER 1000:1000
