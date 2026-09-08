# Build from reviewed manifests in a dedicated secret-free context.
# Pin the base digest in the operator's image build/release process.
FROM node:22-bookworm-slim
WORKDIR /opt/sandbox
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
ARG LOCK_SHA256
LABEL org.xaventra.sandbox.lock-sha256=$LOCK_SHA256
USER 1000:1000
