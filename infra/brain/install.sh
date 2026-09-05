#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Nova Brain — Remote Installer
# ═══════════════════════════════════════════════════════════════════
# Deployed and executed by Nova's brain-installer.ts via SSH.
# Installs: Docker + Neo4j container + Graphiti + brain_api.py
#
# Usage (called by Nova automatically):
#   bash install.sh [--port 8765] [--neo4j-password <pw>]
#
# After install, Brain runs as a systemd service: nova-brain
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

BRAIN_PORT="${BRAIN_PORT:-8765}"
NEO4J_PORT_HTTP="${NEO4J_PORT_HTTP:-7474}"
NEO4J_PORT_BOLT="${NEO4J_PORT_BOLT:-7687}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.nova/brain}"
SERVICE_NAME="nova-brain"
PYTHON="${PYTHON:-python3}"

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)            BRAIN_PORT="$2"; shift 2 ;;
        --neo4j-password)  NEO4J_PASSWORD="$2"; shift 2 ;;
        --install-dir)     INSTALL_DIR="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; shift ;;
    esac
done

if [[ -z "${NEO4J_PASSWORD}" ]]; then
    echo "NEO4J_PASSWORD is required; pass --neo4j-password or set it in the environment." >&2
    exit 1
fi

log()  { echo -e "\n\033[1;34m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✅ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠  $*\033[0m"; }
err()  { echo -e "\033[1;31m❌ $*\033[0m" >&2; }

log "Nova Brain Installer"
echo "  Install dir: $INSTALL_DIR"
echo "  Brain port:  $BRAIN_PORT"
echo "  Neo4j bolt:  $NEO4J_PORT_BOLT"
echo ""

# ── 1. Create install dir ─────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── 2. Check/install Docker ───────────────────────────────────────
log "Checking Docker..."
if ! command -v docker &>/dev/null; then
    warn "Docker not found — installing..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://get.docker.com | sh
        sudo usermod -aG docker "$USER" || true
        ok "Docker installed"
    elif command -v brew &>/dev/null; then
        warn "macOS: install Docker Desktop manually from https://docker.com"
        warn "Then re-run this script."
        exit 1
    else
        err "Cannot auto-install Docker on this OS. Install manually."
        exit 1
    fi
else
    ok "Docker: $(docker --version)"
fi

# ── 3. Start Neo4j container ──────────────────────────────────────
log "Starting Neo4j..."
if docker ps -a --format '{{.Names}}' | grep -q '^nova-neo4j$'; then
    if docker ps --format '{{.Names}}' | grep -q '^nova-neo4j$'; then
        ok "Neo4j already running"
    else
        warn "Nova-neo4j exists but stopped — restarting"
        docker start nova-neo4j
        ok "Neo4j restarted"
    fi
else
    docker run -d \
        --name nova-neo4j \
        --restart unless-stopped \
        -p "${NEO4J_PORT_HTTP}:7474" \
        -p "${NEO4J_PORT_BOLT}:7687" \
        -e NEO4J_AUTH="neo4j/${NEO4J_PASSWORD}" \
        -e NEO4J_PLUGINS='["apoc"]' \
        -e NEO4J_dbms_memory_pagecache_size=512m \
        -e NEO4J_dbms_memory_heap_max__size=512m \
        -v nova-neo4j-data:/data \
        neo4j:5.20-community
    ok "Neo4j container started"
fi

# Wait for Neo4j to be ready
log "Waiting for Neo4j to accept connections..."
MAX_WAIT=60
WAITED=0
until curl -s --max-time 3 "http://localhost:${NEO4J_PORT_HTTP}" &>/dev/null; do
    if [[ $WAITED -ge $MAX_WAIT ]]; then
        err "Neo4j not ready after ${MAX_WAIT}s"
        docker logs nova-neo4j --tail=20
        exit 1
    fi
    sleep 3
    WAITED=$((WAITED + 3))
    echo -n "."
done
echo ""
ok "Neo4j ready at localhost:${NEO4J_PORT_BOLT}"

# ── 4. Python venv + dependencies ────────────────────────────────
log "Setting up Python environment..."

if [[ ! -d ".venv" ]]; then
    $PYTHON -m venv .venv
fi
source .venv/bin/activate

pip install --quiet --upgrade pip
pip install --quiet graphiti-core fastapi uvicorn

# Optional: use local Ollama embeddings instead of OpenAI
OLLAMA_AVAILABLE=false
if curl -s --max-time 3 "http://localhost:11434/api/tags" &>/dev/null; then
    OLLAMA_AVAILABLE=true
    # Ensure embedding model is available
    if ! curl -s http://localhost:11434/api/tags | grep -q 'nomic-embed'; then
        warn "Pulling nomic-embed-text for local embeddings..."
        ollama pull nomic-embed-text || true
    fi
    ok "Ollama available — will use local embeddings"
else
    warn "Ollama not found — Graphiti will use OpenAI embeddings (set OPENAI_API_KEY)"
fi

# ── 5. Deploy brain_api.py ────────────────────────────────────────
log "Deploying Nova Brain API..."
# brain_api.py is copied here by the installer before running this script
if [[ ! -f "brain_api.py" ]]; then
    err "brain_api.py not found in $INSTALL_DIR — installer should have copied it"
    exit 1
fi
ok "brain_api.py ready"

# ── 6. Create .env ────────────────────────────────────────────────
cat > .env <<EOF
NEO4J_URI=bolt://localhost:${NEO4J_PORT_BOLT}
NEO4J_USER=neo4j
NEO4J_PASSWORD=${NEO4J_PASSWORD}
BRAIN_PORT=${BRAIN_PORT}
BRAIN_HOST=0.0.0.0
OLLAMA_URL=http://localhost:11434
EOF
ok ".env written"

# ── 7. systemd service (Linux only) ──────────────────────────────
if command -v systemctl &>/dev/null && [[ "$(uname)" == "Linux" ]]; then
    log "Installing systemd service: ${SERVICE_NAME}"

    sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<SERVICE
[Unit]
Description=Nova Brain API (Graphiti + Neo4j)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/brain_api.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

    sudo systemctl daemon-reload
    sudo systemctl enable "${SERVICE_NAME}"
    sudo systemctl restart "${SERVICE_NAME}"
    sleep 3

    if systemctl is-active --quiet "${SERVICE_NAME}"; then
        ok "Service ${SERVICE_NAME} running"
    else
        err "Service failed to start — check: journalctl -u ${SERVICE_NAME} -n 20"
        exit 1
    fi

elif [[ "$(uname)" == "Darwin" ]]; then
    # macOS: launchd plist
    log "Installing launchd service (macOS)..."
    PLIST="$HOME/Library/LaunchAgents/ai.nova.brain.plist"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.nova.brain</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/.venv/bin/python</string>
    <string>${INSTALL_DIR}/brain_api.py</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NEO4J_URI</key><string>bolt://localhost:${NEO4J_PORT_BOLT}</string>
    <key>NEO4J_USER</key><string>neo4j</string>
    <key>NEO4J_PASSWORD</key><string>${NEO4J_PASSWORD}</string>
    <key>BRAIN_PORT</key><string>${BRAIN_PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/brain.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/brain.log</string>
</dict>
</plist>
PLIST
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    ok "launchd service installed"
fi

# ── 8. Health check ───────────────────────────────────────────────
log "Verifying Brain API..."
MAX_WAIT=30; WAITED=0
until curl -s --max-time 3 "http://localhost:${BRAIN_PORT}/health" | grep -q '"ok":true'; do
    if [[ $WAITED -ge $MAX_WAIT ]]; then
        warn "Brain API not yet responding — may still be starting"
        break
    fi
    sleep 2; WAITED=$((WAITED + 2)); echo -n "."
done
echo ""

HEALTH=$(curl -s "http://localhost:${BRAIN_PORT}/health" 2>/dev/null || echo '{}')
echo "Health: $HEALTH"

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          Nova Brain — Installation Complete          ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║  Brain API:  http://$(hostname):%-24s ║\n" "${BRAIN_PORT}"
printf "║  Neo4j UI:   http://$(hostname):%-24s ║\n" "${NEO4J_PORT_HTTP}"
printf "║  Neo4j bolt: bolt://$(hostname):%-23s ║\n" "${NEO4J_PORT_BOLT}"
echo "╚══════════════════════════════════════════════════════╝"

# Output JSON for installer to parse
echo ""
echo "BRAIN_INSTALL_RESULT=$(cat <<JSON
{
  "ok": true,
  "host": "$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost')",
  "brainUrl": "http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${BRAIN_PORT}",
  "neo4jUrl": "bolt://localhost:${NEO4J_PORT_BOLT}",
  "port": ${BRAIN_PORT}
}
JSON
)"
