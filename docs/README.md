# Xaventra documentation

Public guides for running, understanding and extending Xaventra.

Start with the root [README](../README.md). Contributors should then read the
[development guide](./DEVELOPMENT.md), which maps common changes to their
authoritative source files and required evidence.

## 📚 Contents

| Guide | Description |
|-------|-------------|
| [Development](./DEVELOPMENT.md) | Clean-clone setup, source ownership, change recipes and definition of done |
| [Commercialization](./COMMERCIALIZATION.md) | Licensing models, SBOM and commercial release gates |
| [Quick Start](./QUICKSTART.md) | Get a local Xaventra instance running |
| [Architecture](./ARCHITECTURE.md) | Execution Kernel, service modules, Mesh and trust boundaries |
| [Security](./SECURITY.md) | 5-layer security model (AST, SSRF, Red-Team) |
| [Mesh Network](./MESH.md) | WebSocket events, skill sync, auto-provisioning |
| [Configuration](./CONFIGURATION.md) | All config options explained |
| [Tools Reference](./TOOLS.md) | Available tools and usage |
| [Dashboard](./DASHBOARD.md) | Dashboard user guide |
| [Xaventra Desktop](./DESKTOP.md) | Cross-platform app, Studio, specialists, rooms, models and node enrollment |
| [Self-Update](./SELF_UPDATE.md) | Auto-patching + L24 prompt optimization |
| [Telegram Bot](./TELEGRAM.md) | Telegram integration + wake-up calls |
| [Voice I/O](./VOICE.md) | Speech input/output |
| [Memory System](./MEMORY.md) | LanceDB + Vector Memory + Mesh Memory Sync |
| [Autonomy Guide](./AUTONOMY_GUIDE.md) | Missions, self-evolution, dreaming, Vibe Regler |
| [Troubleshooting](./TROUBLESHOOTING.md) | Common issues & fixes |
| [Production Operations](./PRODUCTION_OPERATIONS.md) | Node roles, health, rollout, rollback and Telegram recovery |
| [Signed Mesh Releases](./MESH-RELEASE-UPDATES.md) | Signed artifact rollout and receipts |
| [Agent Harness Upgrade](./AGENT-HARNESS-UPGRADE.md) | Runtime profiles, resumable agents, ACP and sandboxing |
| [Agent Landscape 2026](./AGENT_LANDSCAPE_2026.md) | Primary-source comparison with Hermes, Agent Zero and other agent runtimes |
| [Trusted Execution](./TRUSTED_EXECUTION.md) | Evidence, validation and promotion rules |
| [Public Release Checklist](./PUBLIC_RELEASE_CHECKLIST.md) | Fail-closed publication and clean-clone gates |

## 🚀 Quick Links

- **Start Xaventra**: `npm run xaventra`
- **Dashboard**: `http://localhost:18789`
- **Config**: `xaventra.config.json`
- **Persona**: `SOUL.md` (editierbar, [LOCKED] Sections geschützt)
- **Logs**: `.nova-data/`
- **Deploy to nodes**: See [Signed Mesh Releases](./MESH-RELEASE-UPDATES.md)

The older `Nova`, `NOVA_*` and `.nova-*` names still appear where they are
compatibility contracts. Public UI and documentation use Xaventra; persisted
identities are migrated only with tested rollback and continuity.
