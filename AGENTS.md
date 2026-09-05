# AGENTS.md

## Public release discipline

- Every completed release change requires a synchronized Core/Desktop version
  bump, changelog and relevant guides. Push only after the applicable gates pass.
- Use `xaventra.config.json` for new installs; `nova.config.json` is a read-in-place
  compatibility fallback. Never publish either runtime configuration.
- Do not call subsystem-probe scores autonomous-agent completion scores. Real
  model acceptance, OS install checks and distributed channel failover are
  separate evidence gates. Preserve failed reports; do not relax tests to pass.

## Local Project Memory — Read First

- If a local `PROJECT_MEMORY.md` exists, read it completely before planning,
  editing, releasing or deploying Xaventra.
- `PROJECT_MEMORY.md` is intentionally ignored because production topology,
  node roles and unfinished operational work are private. Start a private copy
  from `PROJECT_MEMORY.example.md` when operating a deployment.
- Treat the local file as the canonical cross-session record for deployment
  decisions, invariants, node roles and unfinished production work.
- Update the local `PROJECT_MEMORY.md` whenever an architectural decision, node
  role, release rule or production status materially changes.
- Never store passwords, API keys, OAuth tokens, private keys, or other secrets in the project memory.

## Quick Start

```bash
npm install                # Dependencies
npm run build             # TypeScript compilation
npm start                 # Build (via prestart) + start daemon
npm run start:fast        # Start without rebuild (requires dist/ exists)
npm run test              # Core regression suite (vitest run)
npm run typecheck         # tsc --noEmit
```

## Critical Constraints

### Build Freshness Check
- Daemon checks `dist/daemon.js` mtime vs `src/` at startup (src/daemon.ts:21-51)
- Warns if dist is >10s behind src; does NOT block startup
- `npm run dev` — live reload with tsx watch (skips build freshness check)
- `npm run start:fast` — skips rebuild entirely

### Config Required
- `xaventra.config.json` **must exist** before daemon starts (src/daemon.ts:233-237)
- Setup wizard: `npm run cli -- setup`
- Example: `xaventra.config.example.json`
- `.env` file loaded **first** in daemon.ts (before any other import)

### Node Mode
- `NOVA_NODE_ONLY=true` = mesh node (no channels)
- `NOVA_NO_TELEGRAM=true` = disable Telegram only
- Same config shared across all nodes

## Key Commands

### System
- `/help` — all commands
- `/status` — system status
- `/wave new <title>` — start 6-phase mission
- `/wave status` / `/wave approve` — mission control
- `/bot team <preset>` — multi-agent team (default/creative/security/research/fullstack)

### Self-Setup Autopilot (v2.52+)
- `/setup status` — current scan state
- `/setup plan` — fresh scan + action plan
- `/setup research` — web-research missing capabilities (stt/tts/llm/embedding/vision/ffmpeg)
- `/setup apply <id>` — execute action (requires confirmation)
- `/setup apply all` — auto-apply (YOLO mode only)
- YOLO mode: `NOVA_SELF_SETUP_YOLO=1` or `selfSetup.mode = "yolo"` in config

### Self-Evolution / PATCH_GATE (v2.51+)
- `self_evolve` tool → proposal queue (`.nova-data/patch-proposals.json`)
- `/patches` — list proposals
- `/patch approve <id>` — apply (requires `NOVA_PATCH_GATE_TOKEN`)
- **Never execute self_evolve autonomously** — always queued first

### Sub-Agent System
- Max 6 parallel subagents
- Hard abort on timeout via `AbortController`
- Mesh fallback for task routing
- Audit log: `.nova-data/subagent-audit.jsonl`
- Subagent orchestrator: `src/agents/subagent-orchestrator.ts`

## Testing & Verification

- Tests in `src/**/*.test.ts` (vitest, `environment: 'node'`)
- Run: `npm test` (vitest run)
- Watch: `npm run test:watch`
- Skip mesh/LLM init: `NOVA_SKIP_MODEL_RESOLVER_INIT=1 npm test`

### Verification Commands
- `npm run check:build` — dist/ freshness check
- `npm run check:layers` — verify the execution kernel and remaining service modules
- `npm run check:voice` — voice pipeline status

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | LLM providers |
| `TELEGRAM_BOT_TOKEN` | Telegram channel |
| `NOVA_NODE_ONLY` | mesh-node mode (no channels) |
| `NOVA_NO_TELEGRAM` | disable Telegram only |
| `NOVA_PATCH_GATE_TOKEN` | Self-evolution approval |
| `NOVA_SELF_SETUP_YOLO` | Auto-apply setup actions |
| `NOVA_SKIP_MODEL_RESOLVER_INIT=1` | Skip mesh/LLM checks in tests |
| `NOVA_API_TOKEN` | Bearer token for REST API (omit = open, dev only) |
| `NODE_OPTIONS` | `--max-old-space-size=4096` for large deployments |

## Architecture Highlights

### Execution Kernel + Service Modules
- **L0**: Resilience & Self-Repair (health-monitor, self-repair, supervisor, tool-autorepair)
- **L01**: Unified Channels (Telegram, WhatsApp, Discord, Matrix, Slack, CLI, REST)
- **L02**: Context Retrieval
- **L03**: Core Runtime
- **L04**: Multi-Provider Router (failover + JWT guard)
- **L05**: Tool Executor (Smart Tool Router: 112→~22 per request)
- **L06**: Session Manager + Memory (LanceDB + Progressive + KG)
- **L07-L43**: Extended layers (Learning, Vision, Autonomy, Red-Team, etc.)

### Entry Points
- **Daemon** (main): `src/daemon.ts` — master node with all channels
- **CLI**: `src/cli.ts` — terminal chat with full pipeline
- **Boot**: `src/nova-boot.ts` — initialization sequence
- **Supervisor**: `src/supervisor.ts` — background process monitoring

### LLM Provider Order
- Google Gemini → OpenAI → Anthropic → Ollama → external providers
- Fallback chain via `fallbackModels` in config
- JWT guard + apiKey forwarding with failover

## Multi-Node Mesh
- **Master Node**: Windows/macOS, all channels, WebSocket Mesh Hub :9090
- **Edge Nodes**: Jetson AGX Orin, Pi5, Ollama local, mesh-connected
- **Infra Node**: Hetzner, Supabase, OTel Collector, Federated Memory

## Memory Stack

| Tier | Storage | Scope |
|------|---------|-------|
| **0 — Core Facts** | `facts.json` | Always injected, ~50 facts |
| **1 — Session** | In-memory + compressed | Current conversation |
| **2 — LanceDB** | `.nova-vector-memory/` | Semantic search, recent |
| **3 — Journal** | `.nova-data/journal/` | Daily episodic log |
| **4 — Brain** | Graphiti + Neo4j | Long-term, structured facts |

**LanceDB double-write caution**: LanceDB is used exclusively by `message-pipeline.ts`. Double-writes occur if written elsewhere.

## Important Files

- `src/daemon.ts` — entry point, startup sequence, channel wiring
- `src/core/message-pipeline.ts` — main message processing pipeline
- `src/core/slash-commands.ts` — all /command handlers (50+ commands)
- `src/tools/complete-registry.ts` — all tool definitions (~142 tools)
- `src/core/self-setup-orchestrator.ts` — self-setup scan + plan + apply
- `src/agents/subagent-orchestrator.ts` — subagent lifecycle, concurrency, mesh
- `src/llm/nova-llm-sdk.ts` — LLM provider, failover, apiKey forwarding
- `src/layers/L22-federated-memory.ts` — cross-node KG sync
- `src/synthesis/self-evolution.ts` — PATCH_GATE-gated code evolution

## Tool Categories

- **Search**: browser_search → brave_search → google_search → web_search (fallback chain)
- **Memory**: remember (KV) vs kg_search (graph) vs knowledge_store (structured)
- **Subagents**: spawn_subagent (single) vs spawn_subagents_parallel (multi)
- **Files**: read_file vs code_search vs find_files vs code_outline
- **Monitoring**: nova_trace_stats vs health_status vs nova_introspect

## Debugging

- `npm run debug` — start daemon with `NOVA_DEBUG=1`
- `npm run xaventra:stop` — authenticated graceful stop for this runtime only
- `npm run xaventra:restart` — restart only after verified process exit
- Legacy `nova:kill`/`nova:stop`/`nova:restart` use those same scoped controls;
  never kill by process-name pattern or by whichever process owns port 3000.
- `npm run nova:dev` — live reload with tsx watch
- Check logs in `.nova-logs/` (if configured)
- `npm run daemon:logs` — pm2 logs (if running via pm2)

## Known Quirks

### 1. Memory Management
- **LanceDB** used exclusively by `message-pipeline.ts` — double-writes occur if written elsewhere
- Vector + Local + LanceDB: triad recall system

### 2. Security Layers
- **CodeGuardian**: real AST analysis (not regex)
- **SSRFGuard**: server-side request forgery prevention
- **EncryptedMemory**: AES-256-GCM for sensitive data
- **Role-based tool restrictions**: owner/admin/user/guest/blocked

### 3. Build Requirements
- `strict: false`, `noImplicitAny: false` in tsconfig.json
- Node.js ≥22.0.0 required
- `.env` loaded **before** all other imports in daemon.ts

### 4. Config
- `xaventra.config.json` must exist or daemon exits with code 1
- `NOVA_API_TOKEN` env var enables Bearer auth on REST API (omit = open, dev only)

## Deployment

### Edge Nodes (Pi5, Jetson)
```bash
npm run build
scp -r dist/ pi5:/opt/nova/
ssh pi5 "cd /opt/nova && pm2 restart nova"
```

### Docker
```bash
docker build -t nova -f deploy/spark/Dockerfile .
docker run -d -v $(pwd)/xaventra.config.json:/app/xaventra.config.json \
  -v $(pwd)/.nova-data:/app/.nova-data -p 18789:18789 nova
```

## Breaking Changes (verifiable facts only)

### v2.57.0 — State Container
- Use `getNovaState()` and `updateNovaState()` from `src/core/nova-state.ts`
- `globalThis.__novaState` still works (backward compat)

### v2.51.0 — PATCH_GATE
- `self_evolve` tool queues patches — **never run autonomously**
- `/patch approve <id>` required for code changes

### v2.50.0 — Pre-Start Build
- `prestart: "npm run build"` — `npm start` always rebuilds
- `start:fast` skips rebuild

## Debugging-FAQ

| Problem | Solution |
|---------|----------|
| `config.json` invalid | `npm run cli -- wizard` |
| `dist/` stale | `npm run build` |
| LLM timeout | Check API keys + network |
| Mesh node offline | Check `xaventra.config.json` → supabase config |
| Subagent rejected | Max 6 parallel — wait or reduce tasks |
