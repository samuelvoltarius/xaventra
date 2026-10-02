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
| [First Start](./FIRST_START.md) | Install by double-click, first start without a questionnaire, Telegram pairing |
| [Architecture](./ARCHITECTURE.md) | Execution Kernel, service modules, Mesh and trust boundaries |
| [Security](./SECURITY.md) | 5-layer security model (AST, SSRF, Red-Team) |
| [Mesh Network](./MESH.md) | WebSocket events, skill sync, auto-provisioning |
| [Configuration](./CONFIGURATION.md) | All config options explained |
| [Tools Reference](./TOOLS.md) | Available tools and usage |
| [Docker Host Access](./HOST_ACCESS.md) | Authenticated inventory, signed lifecycle permits, operator installation and recovery |
| [Screenshot Delivery](./SCREENSHOT_DELIVERY.md) | Exact capture enrollment, locked-session failures and correlated Telegram acceptance |
| [Dashboard](./DASHBOARD.md) | Die Desktop-Oberfläche im Browser |
| [Desktop-Neugestaltung](./DESKTOP_REDESIGN.md) | Bereiche, Endpunkte, was entfiel |
| [Xaventra Desktop](./DESKTOP.md) | Cross-platform app, Studio, specialists, rooms, models and node enrollment |
| [Self-Update](./SELF_UPDATE.md) | Auto-patching + L24 prompt optimization |
| [Telegram Bot](./TELEGRAM.md) | Telegram integration + wake-up calls |
| [Even G2](./EVEN_G2.md) | Smartglasses: „Hey Even“-Agent + HUD-Feed mit Knopf-Karten |
| [Desktop-Direktverbindung](./DESKTOP_DIRECT.md) | `/desktop`: Einmal-Link auf Xaventras Desktops (ansehen/übernehmen), ohne Passwort im Browser |
| [Voice I/O](./VOICE.md) | Speech input/output |
| [Memory System](./MEMORY.md) | LanceDB + Vector Memory + Mesh Memory Sync |
| [Autonomy Guide](./AUTONOMY_GUIDE.md) | Missions, self-evolution, dreaming, Vibe Regler |
| [Proxmox](./PROXMOX.md) | Wo laufe ich?, /vms, eigene VMs im Pool, Token/Rolle/Fingerprint |
| [Troubleshooting](./TROUBLESHOOTING.md) | Common issues & fixes |
| [Production Operations](./PRODUCTION_OPERATIONS.md) | Node roles, health, rollout, rollback and Telegram recovery |
| [Signed Mesh Releases](./MESH-RELEASE-UPDATES.md) | Signed artifact rollout and receipts |
| [Arbeitsdaten mitnehmen](./MESH_WORKDATA.md) | Entwurf 2.86 Paket J: Git-Quelle im Mesh, gepinnter Commit, nichts in die Cloud |
| [Signed Container Updates](./CONTAINER_UPDATES.md) | Docker-specific controller enrollment, activation and rollback |
| [Native Update Driver](./NATIVE_UPDATE_DRIVER.md) | Native component evidence, isolated acceptance and unfinished production gates |
| [Bounded Task Recovery](./TASK_RECOVERY.md) | Candidate routing corrections and recovery without permission expansion |
| [Update Completion Recovery](./UPDATE_COMPLETION_RECOVERY.md) | Ticket-owned completion lock reconciliation and restart evidence |
| [Agent Harness Upgrade](./AGENT-HARNESS-UPGRADE.md) | Runtime profiles, resumable agents, ACP and sandboxing |
| [Agent Landscape 2026](./AGENT_LANDSCAPE_2026.md) | Primary-source comparison with Hermes, Agent Zero and other agent runtimes |
| [Trusted Execution](./TRUSTED_EXECUTION.md) | Evidence, validation and promotion rules |
| [Public Release Checklist](./PUBLIC_RELEASE_CHECKLIST.md) | Fail-closed publication and clean-clone gates |

## Evidence status

The current source candidate is the 2.78.57 preview, based on published 2.78.56;
see the baseline's [verification record](./VERIFICATION_2.78.56.md). Candidate
guides describe source
that may not yet be signed, published or activated. Tests and isolated fixtures
do not imply production enrollment, successful Telegram screenshot delivery or
completion of the [RC gates](./RELEASE_PLAN.md).

## 🚀 Quick Links

- **Start Xaventra**: `npm run xaventra`
- **Browser**: `http://127.0.0.1:3011/` (dieselbe Oberfläche wie die Desktop-App)
- **Config**: `xaventra.config.json`
- **Persona**: `SOUL.md` (editierbar, [LOCKED] Sections geschützt)
- **Logs**: `.nova-data/`
- **Deploy to nodes**: See [Signed Mesh Releases](./MESH-RELEASE-UPDATES.md)

The older `Nova`, `NOVA_*` and `.nova-*` names still appear where they are
compatibility contracts. Public UI and documentation use Xaventra; persisted
identities are migrated only with tested rollback and continuity.
