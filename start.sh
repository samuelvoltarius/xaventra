#!/bin/bash
set -e

echo "============================================"
echo "  Nova OS - Starting Daemon"
echo "============================================"
echo ""

cd "$(dirname "$0")"

# Build first
echo "[1/3] Building TypeScript..."
npm run build
echo "[OK] Build complete."
echo ""

# Kill existing instance if running
echo "[2/3] Checking for existing Nova process..."
if pgrep -f "node.*daemon.js" > /dev/null 2>&1; then
    echo "Stopping existing Nova..."
    pkill -f "node.*daemon.js" || true
    sleep 2
fi

# Start Nova
echo "[3/3] Starting Nova daemon..."
echo ""
exec node dist/daemon.js
