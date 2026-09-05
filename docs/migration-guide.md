# Migration Guide

Alle Breaking Changes und wichtigen Updates zwischen Nova Versionen.

---

## [2.74.1] (aktuell)

- Nova Desktop routes screen capture to the authenticated interactive client
  instead of attempting it on a headless Main.
- Existing Desktop connection files are migrated automatically with defaults
  for timeout, Enter-to-send, inspector visibility and compact mode.
- Codex aggregate auth capability state moves from `~/.nova` to the canonical
  writable `.nova-data/codex-auth-index` directory. OAuth tokens do not move.

## [2.74.0]

- Nova Desktop and Nova Studio add governed rooms, bots, model/node selection,
  Trust/Memory projections and ADA-inspired capability workspaces.
- Generated skills now enter the single fail-closed Skill Forge; former direct
  activation paths authorize sandbox evaluation only.

## [2.73.0]

- Eine zentrale adaptive Denksteuerung wählt pro Anfrage `fast`, `balanced`,
  `deep` oder `research` und bindet Kontext, Memory, Planung und Budgets an den
  bestehenden Execution Kernel.
- Telegram verwendet eine einzige stille Fortschrittsnachricht, mobile
  Ergebnis-Karten und einen optionalen Trust-Footer statt interner Reasoning-
  Ausgaben.
- Der bisherige Complexity Router ist nur noch eine Kompatibilitätsansicht der
  zentralen Context Policy.

## [2.72.3]

- Malformed Codex planner output now fails closed into Nova's governed fallback.
- Internal planner identity/system-contract prose is rejected before delivery.

## [2.72.2]

- Session summaries can no longer delay an interactive response; foreground
  context compression is deterministic and model-free.
- Model/identity questions report verified runtime state without invoking an
  LLM or claiming unavailable Codex routes.

## [2.72.1]

- Fail-closed Telegram polling after 409 with live lease revalidation.
- Resumable agent harness, runtime profiles, ACP, typed Tool Evidence and
  hash-preserving result pruning.
- Signed Mesh rollout across Docker/systemd profiles with fenced Main authority.
- See `CHANGELOG.md`, `AGENT-HARNESS-UPGRADE.md` and
  `PRODUCTION_OPERATIONS.md` for the complete 2.58–2.72 evolution.

## [2.57.0]

### Neuer State Container
- `src/core/nova-state.ts` ist der neue zentraler State Store
- `(globalThis as any).__novaState` wird weiter unterstützt (backward compatibility)
- **Use `getNovaState()` und `updateNovaState()`** statt direkter `globalThis` Mutationen

### Neue Environment Variablen
- `NOVA_PATCH_GATE_TOKEN` — erfordert Code Changes via PATCH_GATE
- `NOVA_SELF_SETUP_YOLO` — auto-apply fuer Setup Actions
- `NOVA_NODE_ONLY` — mesh-node mode (ohne channels)

---

## [2.56.0]

### Neue CORE_TOOLS
- `spawn_subagents_parallel` — parallel subagent spawning
- `kg_search` — knowledge graph read-only search
- `nova_capabilities(topic?)` — Nova’s eigenes Tool Inventar durchsuchen
- `nova_introspect(type='tools', search?)` — tools gruppiert nach category anzeigen

**Aktion:** Keine Migration nötig — neue Tools sind automatisch aktiviert

---

## [2.55.0]

### BrowserUse Tool Layer
- Neue Tools in `src/tools/browser-use.ts`:
  - `browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, etc.

**Aktion:** Keine Migration nötig — Browser use ist optional aktivierbar

---

## [2.54.0] — [2.53.0]

### Capability Research Layer
- `/setup research` und `/setup plan` now mit web-search enriched actions
- `self_setup_research`, `research_capability_plan`, `research_all_capabilities` tools hinzugefügt

**Aktion:** Keine Migration nötig

---

## [2.52.0]

### Self-Setup Autopilot
- Neuer command: `/setup status`, `/setup plan`, `/setup research`, `/setup apply <id>`
- YOLO mode via `NOVA_SELF_SETUP_YOLO=1` oder `selfSetup.mode = "yolo"`

**Aktion:** Keine Migration nötig — nur neue commands

---

## [2.51.0] — [2.50.0]

### PATCH_GATE Code Evolution
- `self_evolve` tool queues patches zu `.nova-data/patch-proposals.json`
- `/patches` und `/patch approve <id>` commands

**Aktion:** Keine Migration nötig — neue self-evolution workflow

---

## [2.46.1]

### Mesh Registry
- Dynamic node discovery via `nova_mesh_nodes` Supabase table
- Node health reports direkt von Supabase agregiert

**Aktion:** Wenn du Supabase nutzt — sicherstellen, dass `nova_mesh_nodes` Tabelle existiert

---

## [2.44.0] — [2.41.0]

### Neue Intelligence Features
- Soul Evolution (`SOUL.md`)
- Encrypted Memory (AES-256-GCM)
- Wave Pipeline (6-phase missions)
- Wake Word (PI5/Jetson)
- Knowledge Graph
- File Index
- ROI Dashboard
- Progressive Memory
- Token Killer

**Aktion:** Keine Migration nötig — features sind backward compatible

---

## [2.42.0]

### Multi-User Middleware
- Auth Enforcement auf allen messages
- Tool Restrictions (owner/admin/user/guest/blocked)
- Per-User Memory
- Message Coalescing (2.5s window)
- User Onboarding

**Aktion:**Wenn du multi-user support nutzt — `nova.config.json` aktualisieren mit `channels.telegram.allowFrom` arrays

---

## [2.38.0] — [2.10.0]

### Layer 7 (Learning)
- FeedbackCollector
- PatternDetector
- CorrectionLearner
- SkillSynthesizer
- AgentSwarm

**Aktion:** Keine Migration nötig

---

## Upcoming (2.58.0)

### Broken Changes ( planned )
- **State Container**: `getNovaState()` ersetzt `globalThis.__novaState` vollständig
- **Config Schema**: Zod validation stricter
- **Layer Registry**: Dynamic layer loading via `src/layers/registry.js`
