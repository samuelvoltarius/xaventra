# Autonomy Guide (v2.72)

Nova's autonomous capabilities — from missions to dreaming.

---

## Autonomous Missions

For complex multi-step tasks, Nova uses the Mission Engine:

```
User: "Build a Flutter app with Nova dashboard"
    ↓
start_autonomous_mission → goal decomposition
    ↓
Sub-tasks: [setup, scaffold, UI, API, deploy]
    ↓
Execute each sub-task with tool chains
    ↓
Progress updates every 3 steps
    ↓
Final report
```

**Trigger words:** "baue", "erstelle", "autonom", "über Nacht", "fertig bauen"

---

## Self-Think (L11)

Background autonomous thinking when idle:
- Checks system health
- Reviews pending tasks
- Explores optimization opportunities
- Respects quiet hours (23:00 - 07:00)

Config:
```json
"autonomy": {
  "selfThinkEnabled": true,
  "selfThinkMaxPerHour": 2,
  "quietHours": { "enabled": true, "start": 23, "end": 7 }
}
```

---

## Subconscious Dreaming (L21)

When idle for 15+ minutes, Nova enters dream state:

| Phase | What it does |
|-------|-------------|
| 1. Tool Health | Analyze success rates, find broken tools |
| 2. Summaries | Review session summaries for patterns |
| 3. Knowledge | Find duplicates, contradictions |
| 4. LLM Reflection | AI-powered self-analysis |
| 5. Red-Team | Test 20+ attack vectors against own security |
| 6. AST Deep Scan | Re-analyze all code changed today |
| 7. Wake-up Call | Telegram notification with critical insights |

**Timing:**
- Starts: After 15min idle
- Cycle: Every 30min while idle
- Duration: Max 5min per cycle
- Results: `.nova-data/reflector/`

**NOT the same as Heartbeat!** Heartbeat = "am I alive?" (30s). Dreaming = "what did I learn?" (30min).

---

## Self-Evolution (L17)

Nova can create new tools at runtime:

1. User requests capability
2. Nova writes JavaScript tool code
3. Code Guardian + AST security check
4. Tool registered if safe
5. Skill Distributor deploys to all mesh nodes

### Dead-End Detection
- Max 20 attempts per task
- 10-min timeout per approach
- Tracks failed approaches

---

## L23 Instincts

Nova develops unconscious behavioral rules from corrections:

**How it works:**
1. User corrects Nova: "zu technisch!"
2. Nova detects pattern (2+ corrections same category in 7 days)
3. Creates instinct with strength 20
4. Each reinforcement: +10 strength
5. Instincts ≥30 strength → injected into system prompt
6. Decay: -5 per 14 days without reinforcement

**Categories:** tone, verbosity, language, behavior, safety

---

## Predictive Provisioning

Nova learns WHEN you use WHICH model:

```
Mo-Fr 09:00 → gemma3:12b (85% confident)
Sa    20:00 → gemma3:4b  (60% confident)
```

15 minutes before predicted need:
1. **Model Pre-Warm** — Load model with 1-token generation
2. **Context Warm** — Pre-load relevant documents into vector cache
3. **Mesh Notify** — Tell edge nodes to prepare

---

## Auto-Provisioner

When a task exceeds current node capacity:

| Need | Provider |
|------|----------|
| GPU compute | Hetzner Cloud (cx22-cx52) |
| Heavy processing | Docker on ProLiant |
| Light delegation | Mesh node |

Auto-destroys instances after task completion (cost control!).

---

## Selbstheilung (Stufe 3)

Off by default. Enable per node in the config:

```json
{ "autonomy": { "selfHeal": {
    "enabled": true,
    "logRotateBytes": 536870912,
    "diskPercent": 90,
    "endpoints": [
        { "model": "<model>", "endpoint": "http://<first>:8000/v1" },
        { "model": "<model>", "endpoint": "http://<second>:8000/v1" }
    ]
} } }
```

Runs as its own autonomy-loop phase after the Nachtwache (`src/doctor/self-heal.ts`,
recipes in `src/doctor/self-heal-recipes.ts`). Only three recipes act without asking,
all inside the node's own data directory or its own LLM runtime:

| Recipe | Symptom (measured) | Action | After-probe | Rückweg |
|--------|--------------------|--------|-------------|---------|
| `log-rotation` | own audit/log file ≥ `logRotateBytes` | gzip into `.nova-data/self-heal/archive/` (never deleted) | archive unpacks byte-identical | original file restored, broken archive kept as `.unvollstaendig` |
| `cache-leeren` | disk ≥ `diskPercent` and own caches (`tmp`, `cache`, `bench-temp`, `resolver-cache.json`) not empty | move into quarantine, then free it | cache paths empty | everything moved back |
| `endpoint-umschalten` | first endpoint dead twice, second answers (and back when the first returns) | switch the runtime model to the other known endpoint | new endpoint answers | switch back |

Proposals only (never executed): service restart when the Nachtwache sees the own
REST endpoint hanging (max 1× per 6 h, never on the NAS), disk ≥ `diskPercent`,
lease coordinator refusing (403) — report + diagnostics, no DB change.

Brakes: cooldown and daily counter per recipe, `/selbstheilung aus|an` (owner, global
Not-Aus), a recipe switches itself off after 2 failed heals (`/selbstheilung an <rezept>`).
`/heilung` shows status, brakes, open proposals and the journal
(`.nova-data/self-heal/journal/YYYY-MM-DD.jsonl`). The never-list is a code constant;
a recipe touching it is rejected at load. With `NOVA_FENCING_MODE=enforce` and no valid
Main lease nothing acts. Workers never notify the owner; their reports ride the signed
`node.capabilities` message and the Main forwards each one once.

---

## Knopf-Karten, Live-Statuskarte, `/jetzt`, `/gedanken` (Phase 1 Teil A)

Every proposal that needs the owner's answer becomes a **card** with
`[Ja] [Nein] [Später] [Immer erlauben]` (`src/core/approval-cards.ts`).

Fixed rules (code, not config):

- Card id and button tokens are generated by code. `callback_data` is
  `ac:<16 hex>` (19 bytes) and carries no parameters; the action is looked up
  in the card store (`.nova-data/approval-cards/cards.json`).
- Only the owner can answer: a **numeric** Telegram id listed in `allowFrom`.
  Usernames never count.
- Every answer is single-use: the first accepted press consumes all buttons of
  the card; replays, other buttons of the same card and expired cards (default
  24 h) are refused. "Später" consumes the buttons and re-sends the card with
  fresh buttons after 4 h (while it is still valid).
- Nie-Liste actions never become a card; the discarded thought is logged.
- "Immer erlauben" is never offered for physical or outward actions (print,
  switch, send, buy …), whatever the caller declares, and only where an
  existing standing permission exists (today: install catalog level
  `erlauben`, effective in YOLO mode only). PATCH_GATE and self-heal cards
  never offer it.
- "Ja" runs only through a registered executor that wraps an existing path:

| Card | Source | "Ja" | "Nein" |
|------|--------|------|--------|
| `install` | install queue item `queued` (host-agent route) | `approveQueuedInstall` → signed ticket | nothing runs |
| `self-heal` | open `self-heal/proposals.json` item (last 24 h) | proposal marked `angenommen` — **no executor exists, nothing is started** | marked `abgelehnt` |
| `self-heal-peer` | worker proposal via the signed mesh summary | recorded on the Main only | recorded |
| `patch` | queued `patch-proposals.json` item | existing PATCH_GATE approval (`NOVA_PATCH_GATE_TOKEN`, sandbox evidence, signed activation) | marked `rejected` |

- Every answer goes to the Outcome-Ledger format in
  `.nova-data/outcome-ledger/decisions/` (`approval.recorded`, run id
  `approval-card-<id>`), kept apart from the agent-run ledger so button
  presses never count as runs.
- Only the Main with live Telegram authority delivers cards (a minute loop
  started by the Telegram channel, at most 5 new cards per minute); a worker
  (`NOVA_NODE_ONLY=true`) never sends.

API for other modules (e.g. the planner):

```ts
import { createApprovalCard, registerCardExecutor } from './core/approval-cards.js'
registerCardExecutor({
    kind: 'plan-job',                       // [a-z][a-z0-9-]{1,39}, not on the Nie-Liste
    impact: 'intern',                      // 'physisch' / 'extern' -> never "Immer erlauben"
    allowAlways: card => false,            // only with a real standing-permission switch
    async execute(card, answer, ctx) { /* existing path, card.aktion.ref */ return { ok: true, message: '…' } },
    async reject(card, ctx) { return { ok: true, message: 'abgelehnt' } },
    isStillOpen: card => true,             // false closes the card as "erledigt"
})
createApprovalCard({ art: 'plan-job', titel: '…', beleg: '…', vorschlag: '…',
    aktion: { kind: 'plan-job', ref: '<code-generated id>' }, ablaufMs: 3_600_000, dedupeKey: 'plan:<id>' })
// -> { ok: true, card, created } | { ok: false, reason }; the Main delivers it.
```

`noteThought({ quelle, titel, status, text })` adds an entry to `/gedanken`.

**Live-Statuskarte:** in Telegram each task gets one progress message that is
edited in place (`⚙️ Schritt n/m …`, fed by `onStepUpdate` and the heartbeat),
at most one edit per 2 s, and finished as `✅ Fertig · n Schritte · s` or
`❌ Abgebrochen`. A failing edit is logged and ignored.

**`/jetzt`** (owner): running tasks (status cards, task tracker, mission),
install queue, open cards, last decisions. **`/gedanken [n]`** (owner): the
newest thoughts and proposals including discarded/rejected/expired ones, from
the card store, the self-heal journal and proposals, and the install journal.

## Planer, Gedanken und Morgen-/Abendbericht (Phase 1)

Everything is off by default. One job list for everything time-based
(`src/planner/`), a thought list for everything she notices, and a short German
report in the morning and evening.

```json
{ "autonomy": {
    "planner":  { "enabled": true, "tickSeconds": 30, "reminders": false, "nightwatch": false },
    "briefing": { "enabled": true, "morning": "07:30", "evening": "20:00", "timeZone": "Europe/Vienna" },
    "thoughts": { "quietHours": { "start": 22, "end": 7 }, "dedupeMinutes": 360, "maxPerDay": 10 }
} }
```

| Key | Default | Effect |
|-----|---------|--------|
| `autonomy.planner.enabled` | `false` | start the planner (also started by `briefing.enabled`) |
| `autonomy.planner.tickSeconds` | `30` | tick interval (5..600) |
| `autonomy.planner.reminders` | `false` | `set_reminder` creates planner jobs; pending entries of `reminders.json` are taken over once. Off again: open planner reminders go back to `reminders.json` (Rückweg) |
| `autonomy.planner.nightwatch` | `false` | the planner job `sys-nachtwache` runs the probes (needs `autonomy.nightwatch.enabled`); findings become thoughts, the autonomy loop stops probing/alarming itself (self-heal still reads the journal) |
| `autonomy.briefing.enabled` | `false` | jobs `sys-briefing-morgen` / `sys-briefing-abend` |
| `autonomy.briefing.morning` / `evening` | `07:30` / `20:00` | local time (`timeZone`); a report more than 3 h late is logged as `verpasst`, a pending one expires after 6 h |
| `autonomy.thoughts.quietHours` | `22`–`7` | only `dringend` is announced; the rest waits for the next report (or, without report, until the quiet hours end) |
| `autonomy.thoughts.dedupeMinutes` | `360` | the same signature is announced once per window |
| `autonomy.thoughts.maxPerDay` | `10` | daily cap; above it only `dringend`, the rest goes into the report |

**Only the Main delivers.** Delivering jobs (and `mainOnly` jobs such as the
Nachtwache) run only on the node with the fenced Main lease and never with
`NOVA_NODE_ONLY=true`. A worker may add thoughts; it never sends them. A second
process on the same data directory is kept out by `planner/lease.json`.

### Files

| File | Format |
|------|--------|
| `.nova-data/planner/jobs.json` | `{ version: 1, jobs: PlannerJob[] }` — `id` (`job-<12 hex>` or `sys-<name>`, always from code), `kind`, `schedule` (`{type:'einmal',at}` / `{type:'taeglich',time,timeZone}` / `{type:'intervall',minutes}`), `delivers`, `mainOnly`, `enabled`, `status` (`aktiv`/`erledigt`/`aufgegeben`), `nextRunAt`, `lastRunAt`, `lastStatus`, `claim` (run in progress), `pending` (message waiting for the port) |
| `.nova-data/planner/runs.jsonl` | one line per execution: `at, runId, jobId, kind, slot, node, ergebnis (ok/fehler/unterbrochen/verpasst/kein-handler), summary, ms` |
| `.nova-data/planner/deliveries.jsonl` | one line per delivery attempt: `at, deliveryId, kind, port, status (zugestellt/fence/kein-port/fehler/verfallen/tageslimit), node, jobId, slot, thoughtId, attempt, detail` — `jobId@slot` with `zugestellt` is never sent again |
| `.nova-data/thoughts/thoughts.json` | `{ version: 1, items: Thought[] }` (max 500, closed ones dropped first) |
| `.nova-data/thoughts/notify-state.json` | `{ day, sent }` daily counter (local day) |

`Thought`: `id` (`th-<12 hex>`, from code), `source` (`nachtwache`, `install`,
`idee`, …), `kind` (`ereignis`/`idee`/`vorschlag`), `title`, `evidence` (Beleg,
redacted), `importance` (`dringend`/`wichtig`/`normal`/`niedrig`), `rule` (the fixed
rule that set it), `proposal`, `permission` (`selbst`/`fragen`/`nie`), `status`
(`offen`/`erledigt`/`verworfen`/`wartet-auf-knopf`), `signature`, `seen`, `notice`
(`keine`/`ausstehend`/`gemeldet`/`zurueckgehalten`/`im-bericht`), `noticeReason`,
timestamps. Importance rules: `critical` → dringend, `warning` → wichtig,
proposal with `fragen` → wichtig, idea → niedrig, else normal; only dringend and
wichtig are announced. A caller can never set importance or ids.

API for the card layer: `listThoughts`, `getThought`, `setThoughtStatus`,
`addThought` from `src/planner/index.ts`.

### Zustell-Port

The planner never talks to Telegram. The Main wires one port:

```ts
import { setPlannerDeliveryPort } from './planner/index.js'
setPlannerDeliveryPort({ name: 'telegram-karten', deliver: async msg => ({ status: 'zugestellt', ref: '<message id>' }) })
```

`msg` (`PlannerOutgoing`): `id`, `kind` (`briefing`/`gedanke`/`job`), `title`,
`text` (redacted German), `urgency`, `thoughtId`, `permission` (buttons only for
`fragen`, never for `nie`), `refs`, `expiresAt`. Throw a `FenceError` without live
Main authority, return `kein-port` while the channel is down (both: stays pending,
no attempt counted); a real failure is retried up to 5 times. No port wired = all
messages stay pending. Reminders keep their own route (the existing reminder
callbacks), so they work without the port.

### Report

`Morgenbericht` / `Abendbericht` since the last delivered report (max 36 h):
Erledigt (planner runs, thoughts closed as done) · Selbst repariert
(`self-heal/journal`) · Installiert (`install-journal.jsonl`) · Wartet auf dich (open
thoughts with permission `fragen`) · Ideen (max 3) · Zurückgehalten (quiet hours /
cap). Built only from journals on disk, every line redacted, max 5 lines per section.

## Wahrnehmen und Selbst-Einrichtung (Phase 2)

Everything is off by default. `autonomy.sensing.enabled` is the main switch, every
adapter and the device search have their own switch:

```json
{ "autonomy": { "sensing": {
    "enabled": true,
    "notify": { "quietStart": 22, "quietEnd": 7, "maxPerDay": 10, "timezone": "Europe/Vienna" },
    "adapters": {
        "printer": { "enabled": true, "intervalSec": 60, "timeoutSec": 10,
                     "devices": [{ "id": "voron", "type": "moonraker", "url": "http://<lan-ip>:7125" }] },
        "homeassistant": { "enabled": true, "intervalSec": 60,
                           "entities": ["binary_sensor.haustuer", { "id": "binary_sensor.rauchmelder", "urgent": true }] },
        "mail": { "enabled": true, "intervalSec": 300, "knownContacts": ["@firma-x.at", "kunde@example.com"],
                  "imap": { "host": "<imap-host>", "user": "<user>", "passwordEnv": "<ENV_NAME>" } },
        "system": { "enabled": true, "intervalSec": 120 }
    },
    "discovery": { "enabled": true, "deadlineSec": 60, "ratePerSec": 40, "concurrency": 16, "maxHosts": 512, "mdns": true },
    "quietHours": { "ownerSessions": ["<owner-session-name>"] }
} } }
```

**Ereignis-Bus** (`src/sensing/event-bus.ts`): read-only adapters, each with its own
interval, timeout and error counter with backoff; a throwing or hanging adapter never
stops the bus. Events are de-duplicated and turned into thoughts by fixed rules (no
model decides importance or permission). Runs only on the Main, never with
`NOVA_NODE_ONLY=true`.

| Adapter | Reads | Events |
|---------|-------|--------|
| `printer` | Moonraker `/printer/objects/query`, OctoPrint `/api/job` (owner's API key), PrusaLink `/api/v1/status` | „gleich fertig“ (≥ 90 %, once per job), fertig, Fehler (dringend), pausiert |
| `homeassistant` | `GET /api/states/<entity>` for configured entities (URL/token from this adapter, `HASS_URL`/`HASS_TOKEN` or `homeassistant` config) | state change (first observation is only the baseline) |
| `mail` | IMAP with `EXAMINE` + `BODY.PEEK` or Gmail REST `GET` (metadata) | new mail from a known contact and/or with Angebot/Rechnung/Termin; summary = sender + shortened subject + keywords, never the text |
| `system` | Nachtwache journal, Selbstheilung journal, `install-journal.jsonl`, Self-Doctor findings | new failures/results since the last run |

Mail credentials come only from this config (`password` or `passwordEnv`) or an
existing Google profile in the own auth store (`.nova-data/auth.json`). Without them
the adapter does nothing: no guessed hosts, no environment search, no foreign
profiles, no token refresh — the OAuth login stays a one-time owner step.

**Output port** (`src/sensing/ports.ts`): the bus writes only to an `EventSink` and a
`ThoughtSink` (default JSONL: `.nova-data/sensing/events.jsonl`,
`.nova-data/sensing/thoughts.jsonl`). A thought carries source, evidence, importance,
proposal, permission level (`selbst`/`fragen`/`nie`), an optional action for the
button card and a delivery hint (`ok`, `ruhezeit`, `tageslimit`, `nur-protokoll`).
Sensing never sends anything to the owner itself; delivery belongs to the component
attached to the port.

**Selbst-Erkennung** (`/geraete suchen`, owner): read-only search in the own networks
only — subnets of the own interfaces (private ranges, wider than /24 capped to the
own /24) and the tailnet (100.64.0.0/10) only when this node has a tailnet interface.
Every target is re-checked right before connecting (also mDNS answers), public
addresses are rejected twice (range check + SSRF guard). Fixed ports: Moonraker 7125,
OctoPrint 80/5000, PrusaLink 80, Bambu 8883 (TCP connect only), Home Assistant 8123;
identification only via unauthenticated GET paths. Rate limit, concurrency cap and a
hard deadline. Finds land in `.nova-data/sensing/devices.json` as `gefunden` (not in
the main config) and as a thought „Gerät X gefunden … überwachen?“ (level `fragen`).
Monitoring starts only after `approveDevice(id, owner)` — the button card or
`/geraete ja <id>`. API keys/tokens remain owner steps in the config.

`/geraete` lists devices and adapter status; `/geraete ja|nein|aus <id>` approves,
rejects or switches off; `/geraete konten` proposes own mail/calendar accounts
(„lesend verbinden?“); `/geraete ruhe` derives a quiet-hours proposal from the owner's
own message timestamps (`.nova-data/sessions/<owner>.jsonl`, timestamps only). Until a
proposal is accepted the cautious default applies: 22–7 only urgent, max. 10 per day.
