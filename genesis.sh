#!/bin/bash
# ============================================
# NOVA GENESIS PROTOCOL
# ============================================
# Full install:  ./genesis.sh
# Update only:   ./genesis.sh --update
# Start modes:   ./genesis.sh --start --mode=main
#                ./genesis.sh --start --mode=node
# Combined:      ./genesis.sh --update --start --mode=node
# ============================================

set -e

NOVA_DIR="${NOVA_DIR:-$(pwd)}"
REPO_URL="https://github.com/samuelvoltarius/xaventra.git"
MAIN_SERVER="root@192.0.2.12"

# ============================================
# Parse Arguments
# ============================================
ACTION="install"    # install | update | start
MODE="main"         # main (with Telegram) | node (no Telegram)
DO_START=false

for arg in "$@"; do
    case $arg in
        --update)       ACTION="update" ;;
        --start)        DO_START=true ;;
        --mode=main)    MODE="main" ;;
        --mode=node)    MODE="node" ;;
        --node)         MODE="node" ;;
        --main)         MODE="main" ;;
        --help|-h)
            echo "Nova Genesis Protocol"
            echo ""
            echo "Usage:"
            echo "  ./genesis.sh                    Full install (first time)"
            echo "  ./genesis.sh --update           Pull latest code + rebuild"
            echo "  ./genesis.sh --start            Start Nova (default: main mode)"
            echo "  ./genesis.sh --start --node     Start as edge node (no Telegram)"
            echo "  ./genesis.sh --update --start   Update + restart"
            echo ""
            echo "Modes:"
            echo "  --main    Full Nova with Telegram (default)"
            echo "  --node    Edge node only (mesh participant, no Telegram)"
            exit 0
            ;;
    esac
done

echo "
╔═══════════════════════════════════════════════╗
║           NOVA GENESIS PROTOCOL               ║
║         Action: $(printf '%-10s' $ACTION) Mode: $(printf '%-6s' $MODE)       ║
╚═══════════════════════════════════════════════╝
"

# ============================================
# Detect OS
# ============================================
detect_os() {
    if [ -f /etc/debian_version ]; then echo "debian"
    elif [ -f /etc/redhat-release ]; then echo "redhat"
    elif [ -f /etc/arch-release ]; then echo "arch"
    elif [[ "$(uname)" == "Darwin" ]]; then echo "macos"
    else echo "unknown"; fi
}

OS=$(detect_os)
echo "🔍 OS: $OS | Node: $(node -v 2>/dev/null || echo 'not installed')"

# ============================================
# UPDATE MODE
# ============================================
if [ "$ACTION" = "update" ]; then
    echo ""
    echo "🔄 Updating Nova..."

    cd "$NOVA_DIR"

    # Method 1: Git pull (if .git exists)
    if [ -d .git ]; then
        echo "  📥 Git pull..."
        git pull --ff-only 2>/dev/null || git pull --rebase 2>/dev/null || {
            echo "  ⚠️ Git pull failed — trying stash + pull"
            git stash && git pull --ff-only && git stash pop 2>/dev/null || true
        }
        echo "  ✅ Git updated"

    # Method 2: Fetch from main server (tar pipe)
    elif ssh -o ConnectTimeout=5 "$MAIN_SERVER" "test -d /opt/nova-core/src" 2>/dev/null; then
        echo "  📡 Fetching from main server..."
        ssh "$MAIN_SERVER" "cd /opt/nova-core && tar czf - src/ package.json package-lock.json" | tar xzf -
        echo "  ✅ Server sync complete"

    # Method 3: Fetch from GitHub release archive
    else
        echo "  📦 Downloading latest release..."
        ARCHIVE_URL="${REPO_URL%.git}/archive/refs/heads/master.tar.gz"
        curl -sL "$ARCHIVE_URL" | tar xzf - --strip-components=1 -C "$NOVA_DIR" 2>/dev/null || {
            echo "  ❌ Update failed — no git, no server, no archive"
            exit 1
        }
        echo "  ✅ Archive download complete"
    fi

    # Install deps if package.json changed
    echo "  📦 Checking dependencies..."
    npm install --silent 2>/dev/null
    npm install tsx --save-dev --silent 2>/dev/null

    VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "?.?.?")
    echo "  ✅ Nova v${VERSION} updated"
fi

# ============================================
# FULL INSTALL (first time)
# ============================================
if [ "$ACTION" = "install" ]; then

    # --- Stage 1A: Base Dependencies ---
    echo ""
    echo "📦 Stage 1A: Installing base dependencies..."
    case $OS in
        debian)   apt-get update -qq && apt-get install -y -qq curl git build-essential ca-certificates gnupg ;;
        redhat)   yum install -y curl git gcc-c++ make ca-certificates ;;
        arch)     pacman -Sy --noconfirm curl git base-devel ;;
        macos)    xcode-select --install 2>/dev/null || true ;;
        *)        echo "⚠️ Unknown OS — skipping system deps" ;;
    esac
    echo "✅ Base dependencies installed"

    # --- Stage 1B: Node.js 22+ ---
    echo ""
    echo "📦 Stage 1B: Checking Node.js..."
    INSTALL_NODE=false
    if command -v node &>/dev/null; then
        NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_MAJOR" -ge 22 ]; then
            echo "✅ Node.js $(node -v) OK"
        else
            echo "⚠️ Node.js too old ($(node -v)), upgrading..."
            INSTALL_NODE=true
        fi
    else
        INSTALL_NODE=true
    fi

    if [ "$INSTALL_NODE" = true ]; then
        case $OS in
            debian) curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs ;;
            redhat) curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && yum install -y nodejs ;;
            arch)   pacman -S --noconfirm nodejs npm ;;
            macos)  brew install node@22 || { curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && nvm install 22; } ;;
        esac
        echo "✅ Node.js $(node -v) installed"
    fi

    # --- Stage 1C: Clone/Update Repo ---
    echo ""
    echo "🧠 Stage 1C: Downloading Nova..."
    if [ ! -d "$NOVA_DIR/src" ]; then
        if [ "$NOVA_DIR" = "$(pwd)" ] && [ ! -d .git ]; then
            # Clone into current directory
            git clone "$REPO_URL" "$NOVA_DIR" 2>/dev/null || {
                echo "  📡 Git clone failed — trying server sync..."
                mkdir -p "$NOVA_DIR"
                ssh -o ConnectTimeout=5 "$MAIN_SERVER" "cd /opt/nova-core && tar czf - src/ package.json package-lock.json scripts/" | tar xzf - -C "$NOVA_DIR"
            }
        fi
        echo "✅ Nova downloaded to $NOVA_DIR"
    else
        echo "✅ Nova already exists at $NOVA_DIR"
    fi

    cd "$NOVA_DIR"

    # --- Stage 1D: Install Dependencies ---
    echo ""
    echo "📦 Stage 1D: Installing npm dependencies..."
    npm install --silent
    npm install tsx --save-dev --silent
    echo "✅ Dependencies installed"

    # --- Stage 1E: Config ---
    echo ""
    echo "⚙️ Stage 1E: Checking configuration..."
    if [ ! -f nova.config.json ]; then
        cat > nova.config.json << 'NOVACONF'
{
    "name": "Nova",
    "emoji": "✨",
    "version": "2.24.1",
    "provider": "google-antigravity",
    "model": "gemini-3-flash",
    "internalModel": "gemini-3-flash",
    "fallbackModels": ["gemini-3-flash"],
    "personality": {
        "language": "de",
        "tone": "professional-friendly"
    },
    "telegram": {
        "enabled": false
    }
}
NOVACONF
        echo "⚠️ nova.config.json created — run 'nova login' to authenticate"
    else
        echo "✅ nova.config.json exists"
    fi

    DO_START=true
fi

# ============================================
# START NOVA
# ============================================
if [ "$DO_START" = true ]; then
    echo ""
    cd "$NOVA_DIR"
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "?.?.?")

    # Kill any existing Nova process
    pkill -f "node.*daemon" 2>/dev/null || true
    pkill -f "tsx.*daemon" 2>/dev/null || true
    sleep 1

    if [ "$MODE" = "node" ]; then
        echo "🌐 Starting Nova v${VERSION} as EDGE NODE (no Telegram)..."
        export NOVA_NODE_ONLY=true
        export NOVA_NO_TELEGRAM=true
        nohup npx tsx src/daemon.ts > /tmp/nova-node.log 2>&1 &
        NOVA_PID=$!
        sleep 3

        if kill -0 $NOVA_PID 2>/dev/null; then
            echo "✅ Nova edge node started (PID: $NOVA_PID)"
            echo "   Log: /tmp/nova-node.log"
            echo "   Mode: Mesh participant (no Telegram)"
        else
            echo "❌ Nova failed to start! Check /tmp/nova-node.log"
            tail -10 /tmp/nova-node.log 2>/dev/null
            exit 1
        fi

    else
        echo "🚀 Starting Nova v${VERSION} as MAIN (with Telegram)..."
        nohup npx tsx src/daemon.ts > /tmp/nova-main.log 2>&1 &
        NOVA_PID=$!
        sleep 3

        if kill -0 $NOVA_PID 2>/dev/null; then
            echo "✅ Nova main started (PID: $NOVA_PID)"
            echo "   Log: /tmp/nova-main.log"
            echo "   Mode: Full (Telegram + Mesh + Gateway)"
        else
            echo "❌ Nova failed to start! Check /tmp/nova-main.log"
            tail -10 /tmp/nova-main.log 2>/dev/null
            exit 1
        fi
    fi
fi

# ============================================
# Summary
# ============================================
echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║       ✅ NOVA GENESIS COMPLETE                ║"
echo "╠═══════════════════════════════════════════════╣"
printf "║  Version: %-35s║\n" "$(node -p "require('$NOVA_DIR/package.json').version" 2>/dev/null || echo '?')"
printf "║  Mode:    %-35s║\n" "$MODE"
printf "║  Dir:     %-35s║\n" "$NOVA_DIR"
echo "╠═══════════════════════════════════════════════╣"
echo "║  Commands:                                    ║"
echo "║    Update:  ./genesis.sh --update             ║"
echo "║    Restart: ./genesis.sh --start --main       ║"
echo "║    Node:    ./genesis.sh --start --node       ║"
echo "╚═══════════════════════════════════════════════╝"
