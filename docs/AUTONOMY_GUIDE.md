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

## Denken (Phase 3): Ideen, Modell-Scout, Bug-Finder, Lernen

Off by default. Nothing runs until `autonomy.thinking.enabled` **and** the part's own
switch are `true`. Runs as its own autonomy-loop phase after the Doctor, **only on the
Main** (workers think nothing and send nothing). Code: `src/thinking/`.

```json
{ "autonomy": { "thinking": {
    "enabled": true,
    "ideas":     { "enabled": true, "nightStartHour": 1, "nightEndHour": 5, "maxPerDay": 3 },
    "scout":     { "enabled": true, "memoryBudgetGB": 96, "minImprovementPercent": 5,
                   "sources": [ { "type": "huggingface", "limit": 50, "timeoutMs": 10000 },
                                { "type": "fixture", "path": ".nova-data/thinking/scout-fixture.json" } ] },
    "bugFinder": { "enabled": true, "minOccurrences": 5, "windowDays": 7 },
    "learning":  { "enabled": true },
    "load":      { "maxGpuUtilPercent": 20, "vllmMetricsUrl": "http://127.0.0.1:8000" }
} } }
```

| Part | When | What it does | Output |
|------|------|--------------|--------|
| Ideen-Lauf | night window, ≤ 1×/day, only if GPU/vLLM measured idle | fixed rules over traces (`analyzeTraces`, same numbers as `nova_trace_stats`), tool latency, error rate, repeated arguments, retries, model success rate, L14 costs; the model only words the text | ≤ 3 ideas/day (hard cap, config can only lower), each with evidence (number before + source) and a measurable target, stage `fragen` |
| Modell-Scout | weekly | candidates from configured sources (Hugging Face API read-only GET with time limit, or offline fixture; no source = nothing), filter: fits GB10 memory (unknown size = rejected), vLLM-compatible (transformers/safetensors, not GGUF-only), licence allow-list; probe set from Doctor cases + anonymous everyday questions (private content is dropped, numbers masked); comparison only through an injected `ScoutRunner` and only while the GPU is idle | "Modell Z war X % besser" with test report, stage `fragen`. **Never switches by itself**, downloads nothing, starts no model |
| Bug-Finder | hourly | same fault fingerprint (Stufe-1 `observationFingerprint`) ≥ N times with evidence → one Doctor case in the existing queue; no duplicates (same fingerprint/case id = skipped) | Doctor investigation → on `verified` the existing Claude handoff → after a rollout the existing follow-up check |
| Lernen | on every button answer | `recordDecision(kind, answer)` → outcome ledger; after 5× "Ja" in a row (minimum, config can only raise) a thought "Immer erlauben?" — never for printing, switching, sending, buying, never for the never-list; "Nein" lowers future importance of that kind (min. factor 0.2) | thought, stage `fragen` |

Load gate (`LoadProbe`): `nvidia-smi utilization.gpu` (no shell, time limit, 3 samples, max
counts) plus vLLM `/metrics` queue when `load.vllmMetricsUrl` is set. Not measurable =
busy. GPU above `maxGpuUtilPercent` or any running/waiting vLLM request = no run (OOM 13.09.).

Ports (documented in `src/thinking/ports.ts`):
- `ThoughtSink` — the only exit. Default appends to `.nova-data/thinking/thoughts.jsonl`
  (0600, secrets redacted). `proposal.autoExecute` is always `false`; execution needs an
  owner button and a code-generated ticket (Phase 1 cards). Replace with `setThoughtSink`.
- `Schedule` — default `IntervalSchedule` (ideas 20 h, scout 7 days, bugs 1 h, state in
  `.nova-data/thinking/schedule.json`), polled once per autonomy cycle. Replace with
  `setThinkingSchedule` (planner jobs).
- `ScoutRunner` (`setScoutRunner`) and idea `Formulator` (`setIdeaFormulator`; the daemon
  wires the running model) are optional.

State files: `.nova-data/thinking/ideas-state.json`, `scout-report.json`, `decisions.json`.


## Software-Scout (Phase 5b, Vorschläge Standard AUS)

"Welche Software/KI kann auf welchem Knoten laufen, und was fehlt im Mesh?" Code:
`src/install/software-candidates.ts` (Kandidaten-Katalog), `src/install/software-scout.ts`
(Eignung, Lücken, `/software`, Lauf), Gedanken-Ausgang in `src/core/thought-hub.ts`.

```json
{ "autonomy": { "softwareScout": { "enabled": true } } }
```

- **Kandidaten-Katalog** (im Repo, Teil des Releases, veröffentlicht als
  `docs/generated/software-candidates.json`, nie aus dem Netz oder vom Modell): je Eintrag
  `id`, `capability` (`stt` `tts` `vision` `embedding` `browser` `media` `desktop` `llm`),
  `kind` (`system` | `model` | `runtime`), `platforms`, `arches`, `minRamGB`, `minDiskGB`,
  `gpu` (`none` | `nvidia`) + `minVramGB`, `heavy`, optional `roles`, `requiresService`
  (`ollama`), `detect` (Werkzeug-/Dienstnamen aus dem Knotenprofil), `catalogId` (Verweis auf
  den Stufe-2-Installationskatalog) und `benefit`. Ein Kandidat trägt **keinen Befehl**.
  Beim Laden abgelehnt (nie repariert): unbekannte Felder (z. B. `install`), Nie-Liste (die
  `id` und alle `packages` werden wie Paketnamen geprüft: `cuda*`, `nvidia-*`, `openssh*` …),
  unbekannte `catalogId`, Art/Plattform/Architektur/GPU passt nicht zum Katalogeintrag.
- **Eignung je Knoten** (reine Funktion `assessCandidate`, Kandidat × Knotenprofil; eigenes
  Profil + signierte Peer-Profile aus `node.capabilities`, kein SSH): Ergebnis `passt` /
  `passt-nicht` / `vorhanden` / `installiert` mit Grund. Regeln in dieser Reihenfolge:
  Fähigkeit läuft schon (Dienst `running` oder Werkzeug) → `vorhanden`; Dienst/Werkzeug
  des Kandidaten installiert, läuft aber nicht → `installiert`; Plattform, Architektur;
  **NAS nur Modelle** (kein Systempaket, kein Programm); Rolle; zu wenig RAM; benötigte
  Laufzeit (Ollama) fehlt; Platte < Bedarf + 10 GB; GPU: NVIDIA nötig, Speicher nur bei
  Unified Memory (GB10 …) bekannt, diskrete GPU ohne Speicherangabe wird nicht
  vorgeschlagen; **neben laufendem vLLM nie `heavy`**, sonst nur ohne Engpass (Arbeitsspeicher-
  Prüfung `ok`, keine wartenden vLLM-Anfragen, GPU < 90 %) und mit freiem Speicher ≥ Bedarf
  + 8 GB Reserve (STUFENPLAN Grenze 6, OOM 13.09.). Weg: mit `catalogId` entscheidet
  `planInstallRoute` (Host-Agent nur lokal, Container nur neues Image, NAS nur Daten-Volume);
  ohne `catalogId` nur „Katalogeintrag nötig" (im Container: nur über ein neues Image;
  schreibgeschütztes System: nur über den Host-Agenten).
- **Bester Knoten** je Fähigkeit: vorhandener Katalogweg vor „Katalogeintrag nötig", dann die
  Reihenfolge im Kandidaten-Katalog (Qualität), dann Knoten mit Host-Agent und viel freiem
  Speicher; CPU-Lasten eher nicht auf den vLLM-Knoten. GPU-Lasten passen nur dort, wo eine
  GPU mit genug freiem Speicher ist (Spark).
- **Lücken**: eine Fähigkeit, die auf keinem frischen Knoten (Herzschlag ≤ 10 min) läuft und
  für die ein Kandidat passt → Gedanke, Stufe `fragen`, z. B. „Whisper large-v3 (GPU) passt
  auf xaventra-spark (42 GB frei), auf ns1 keine NVIDIA-GPU, auf ns2 zu wenig RAM (4 GB,
  nötig 8 GB). Einrichten?". Höchstens 3 je Lauf. Läuft wöchentlich und bei Profiländerung
  (Stufe-1-Fingerabdruck, frühestens 30 min nach dem letzten Lauf), nur auf dem Main mit
  Autonomie-Lease; Worker schlagen nichts vor und senden nichts. Entprellt: derselbe
  Vorschlag (Fähigkeit + Kandidat + Knoten) höchstens einmal je 7 Tage, nach „Nein" 30 Tage
  nicht. Zustand: `.nova-data/software-scout/state.json`.
- **Knopf**: Der Gedanke merkt sich nur Kandidaten-ID und Knoten (vom Code, gegen den
  Kandidaten-Katalog geprüft). „Ja" mit `catalogId` = vorhandener Stufe-2-Weg:
  `proposeCatalogInstall(..., 'scan')` → Installations-Warteschlange → eigene
  Installations-Karte → signiertes Ticket an den Host-Agenten (bzw. Image-Vorschlag für
  Container, Daten-Volume für Modelle). „Ja" ohne `catalogId` = nur Vermerk „Katalogeintrag
  nötig", es wird nichts installiert. Eine im Gedanken mitgeschickte Katalog-ID wird
  ignoriert.
- **`/software`** (Owner, immer verfügbar, nur lesend, auch wenn Vorschläge aus sind): je
  Fähigkeit „vorhanden wo" / „passt wo" (mit Weg) / „passt nicht" (mit Grund) / „fehlt".
  „Vorhanden" heißt erkannt, nicht Ende-zu-Ende geprüft (Erkannt ≠ nutzbar).
- Knotenprofil: neues optionales Feld `services` (lokale KI-Dienste aus dem AI-Scanner:
  `name`, `type`, `status`), beim Empfang begrenzt (max. 20, bekannte Typen); ältere Peers
  ohne das Feld bleiben gültig.

## Selbst-Update vorbereiten (Phase 4, Standard AUS)

```json
{ "autonomy": { "selfUpdate": {
    "enabled": false,
    "intervalMinutes": 360,
    "channel": "stable",
    "publisherKeys": { "xaventra-update-20260910": "-----BEGIN PUBLIC KEY-----…" }
} } }
```

`src/core/self-update/` only **reads and proposes**; it never downloads programs or
images, never stages, activates, restarts or switches anything.

- **Update watcher** (`release-watch.ts`, `startSelfUpdateWatch`): every
  `intervalMinutes` (30–1440) it reads the GitHub release listing, the signed
  `xaventra-update.json`, `SHA256SUMS` and the small per-architecture descriptors
  (≤ 64 KiB each, normally < 1 KiB). The manifest is checked with the existing
  `verifyUpstreamManifest` against the **pinned** publisher key
  (`xaventra-update-20260910`, SPKI SHA256 `12c93226…f887a`); an enrolled key with
  another fingerprint is refused before any request. SHA256SUMS must equal the signed
  inventory, every descriptor must match size, SHA256 and container identity. Only a
  version above the installed one is eligible (no downgrade); `stable` means tags
  without `-rc` (the publisher marks every signed preview as a GitHub prerelease).
  Result: one thought per release id, stage `fragen` — „2.8x verfügbar, geprüft,
  Änderungen: … Installieren?“ — with proposal `self-update.activate`
  `{version, releaseId, commit, planHash?}`. Repeated checks and restarts do not
  repeat it (state `.nova-data/self-update/watch-state.json` chosen by the caller). A
  rejected release becomes one information thought (`selbst`, no proposal).
  `enabled` must be literally `true`; otherwise no timer and no network access.
- **Activation plan** (`activation-plan.ts`, `buildActivationPlan`): data only, built
  from the verified release and node profiles (`native-spark`, `container-worker`,
  `container-nas`, `excluded`). Spark follows runbook 3.4b (host re-verification,
  extraction without starting a container, isolated lifecycle, preflight, stop,
  read-only freeze, independent copy with source/copy/source hash, unit/link switch,
  post-probes, receipt) and the 3.5 rollback; containers follow the approved worker
  swap (digest pull, label check, backup with count/byte comparison — reflink on the
  NAS —, rollback container `restart=no`, node-only env). Order: workers, then NAS,
  Spark last; Pi excluded; no step restarts a host, the NAS host never. `planHash`
  binds a later approval to exactly this plan.
- **Fencing enforce readiness** (`fencing-readiness.ts`): read-only report whether
  `NOVA_FENCING_MODE=enforce` would be safe — all four v5 RPCs present, the **real
  PostgREST app role** may execute them (lesson 30.09.: 403 after v5 granted only
  `nova_anon`), lease table locked, lease protocol v2, every active node ≥ 2.79.0,
  receiver high-water marks ≤ the coordinator epoch (unknown = not safe). The probe
  uses only GET (OpenAPI listing and the STABLE RPCs `nova_fencing_status`,
  `nova_check_fence`). The result is one thought; nothing is switched.

Thoughts go through the `ThoughtSink` port (`thought-sink.ts`); the default
`JsonlThoughtSink` appends JSON lines. The approval cards attach to this port during
integration; the daemon does not start the watcher yet.


## Delegation und proaktive Erinnerungen (Phase 6e, Standard AUS)

```json
{ "autonomy": {
    "delegation":    { "enabled": false, "url": null, "fromAgent": "NOVA", "pollSeconds": 120, "defaultFristMinutes": 1440, "maxOpen": 20 },
    "autoReminders": { "enabled": false, "offerDays": 5, "invoiceDays": 7, "missionWaitHours": 24, "followUpTime": "09:00", "eveningTime": "20:00", "maxPerDay": 5 }
} }
```

### Delegation an Unteragenten (`src/core/delegation.ts`)

API for missions and other modules:

```ts
import { delegate, onDelegationSettled, registerDelegationVerifier } from './core/delegation.js'
const result = await delegate({
    to: 'claude' | 'codex' | 'hermes' | 'subagent',
    auftrag: 'Analysiere, warum der Doctor-Fall wiederkehrt',
    kontext: { befund: '…' },                       // cleaned before it leaves (see below)
    erwartet: { art: 'release-tag', tag: 'v2.82.0' }, // or { art: 'ci-gruen', sha }, or { art: 'beschreibung', text }
    frist: 240,                                     // minutes or ISO instant (5 min .. 14 days, default 24 h)
    missionId: 'm-…',                               // optional, handed back to the listener
    aendert: false,                                 // optional; can only raise the level
})  // -> { ok: true, record } | { ok: false, reason }
onDelegationSettled((record, { verified }) => { /* mark a mission step done only when verified */ })
```

| Field | Meaning |
|-------|---------|
| `record.id` | `dlg-<12 hex>`, generated by code; thread id `xaventra-delegation-<id>` |
| `record.status` | `wartet-auf-freigabe` → `gesendet` → `angenommen` → `fertig` / `abgelaufen` / `abgelehnt` / `fehler` |
| `record.stufe` | `L1` (sent at once) or `L2` (Knopf-Karte `delegation`, sent only after Ja) |
| `record.antwort` | the answer text, **untrusted data**, never executed |
| `record.beleg` | short evidence from `metadata.beleg` of the answer (unchecked) |
| `record.pruefung` | `verifiziert` / `nicht-erfuellt` / `unverifiziert` + detail, from Nova's own read-only check |
| `record.ignoriert` | names of answer fields that were ignored (new goal, rights, criteria, deadline …) |

Rules (code, not config):

- **Level:** reading/analysing tasks are L1. As soon as the task asks for changes
  to systems (deploy/ausrollen, installieren, merge/push/commit, neu starten/stoppen,
  ändern, löschen, beheben/patchen/implementieren, aktualisieren) it is L2: a card
  „Auftrag an Claude senden?“, sent only after the owner's Ja, Nein = not sent. The
  rule can only raise the level. Nie-Liste topics (secrets/passwords, deleting
  backups/data, NAS restart, DB migration, firewall/SSH/Tailscale, kernel/driver) are
  refused, also as a card. No "Immer erlauben".
- **Context:** keys naming memory, journal, secrets, auth, sessions, prompts, customers,
  contacts, mail/phone/address/IBAN are dropped; e-mail addresses, phone numbers, IBANs
  and lines mentioning memory files (`MEMORY.md`, `facts.json`, `SOUL.md`, LanceDB …)
  are removed; secrets are redacted; 2000 characters max. `record.kontextEntfernt`
  lists what was removed.
- **Ways:** `subagent` runs the existing orchestrator locally with a fixed read-only
  tool list (web/read/list/calculate/time/system info — no memory, shell, writes or
  sending). `claude`/`codex`/`hermes` go to the Agentic OS: `POST <url>/messages`
  `{to_agent: CLAUDE|CODEX|HERMES, from_agent: NOVA, thread_id, content, metadata}`.
  `url` defaults to `autonomy.claudeHandoff.url`; without a URL only local subagents work.
- **Rückkanal:** every `pollSeconds` the Main reads `GET <url>/agent_registry/NOVA/inbox`.
  Only a message with the exact delegation thread id, addressed to NOVA (when `to_agent`
  is present) and sent by the agent the task went to is applied; everything else is
  ignored. The answer may set `metadata.status` (`angenommen` | `fertig` | `abgelehnt`;
  missing = result) and `metadata.beleg`. The text is stored as data. It is never
  executed, never becomes a tool call, a card or a new delegation, and cannot change
  the task, criterion, level, deadline or mission.
- **Verification:** the check is chosen from Nova's own `erwartet`, never from the
  answer. `release-tag`: GitHub release exists and is not a draft (GET
  `/repos/<repo>/releases/tags/<tag>`). `ci-gruen`: every GitHub Actions run of the
  commit is completed and successful (GET `/actions/runs?head_sha=`). Other criteria
  stay `unverifiziert` unless a module registers a read-only check
  (`registerDelegationVerifier(art, fn)`). A thought „erledigt (geprüft)“ and the
  listener's `verified: true` happen only for `verifiziert`.
- **Deadline:** an open delegation past its deadline becomes `abgelaufen` and leaves
  a thought (`wichtig`).
- Main only: a worker (`NOVA_NODE_ONLY=true`) refuses `delegate()` and never polls.

**`/delegiert [n]`** (owner): open and the last n finished delegations with status,
level, criterion, check result, evidence and the (untrusted) answer excerpt.

File: `.nova-data/delegation/delegations.json`.

### Proaktive Erinnerungen aus Quellen (`src/planner/auto-reminders.ts`)

Needs the planner (`autonomy.planner.enabled=true`). Fixed rules:

| Rule | Source | Stufe | Result |
|------|--------|-------|--------|
| Angebot unbeantwortet | Wahrnehmen mail event with keyword `angebot` | fragen | after `offerDays`: thought „Angebot von X seit 5 Tagen unbeantwortet — morgen 09:00 nachfragen?“; the reminder job is created only after Ja |
| Rechnung | mail event with keyword `rechnung` | fragen | after `invoiceDays`: „… morgen 09:00 an die Zahlung erinnern?“, job after Ja |
| Termin | calendar event (`calendar.event`/`kalender.termin` with `evidence.start`) | selbst | reminder on the evening before at `eveningTime` for appointments before noon, else 2 h before; moved out of quiet hours (earlier first) |
| Release unbestätigt | Release-Wächter thought `update-rejected` | selbst, intern | job tomorrow at `followUpTime` that re-checks read-only; the result is a thought, nothing is sent |
| Mission wartet | `noteMissionWaiting({ missionId, title, since })` | fragen | after `missionWaitHours`: „Mission … wartet auf dich — morgen 09:00 erinnern?“ |

- Each source is handled once (dedupe by key, kept 60 days); at most `maxPerDay`
  questions/self jobs per local day, the rest waits for the next day.
- Never mail text: only the sender label (name + domain) and the keyword are kept.
  „Unbeantwortet“ means no reply was seen — the sent folder is not read; Nein closes it.
- Quiet hours come from `autonomy.thoughts.quietHours`; a reminder that falls due
  during quiet hours anyway is not sent but goes into the next report.
- Planner jobs: `auto-erinnerung` (delivers, Main only), `auto-pruefung` (internal),
  system job `sys-auto-erinnerungen` (every 30 min, Main only). Switching the feature
  off disables the system job.

File: `.nova-data/auto-reminders/state.json`.

---

## Verantwortungen und Missionen (Phase 6b, Standard AUS)

Xaventra leitet selbst ab, wofür sie sorgt, und arbeitet innerhalb **einer**
Aktions-Policy weiter — ohne dass Alfred es ihr sagt. Off until
`autonomy.responsibilities.enabled=true`; Main only (never with `NOVA_NODE_ONLY`,
only with the global autonomy authority / Main lease).

```json
{ "autonomy": { "responsibilities": {
    "enabled": true,
    "intervalMinutes": 15,
    "budgetMinutes": 120,
    "maxToolCalls": 20
} } }
```

### Einheitliche Aktions-Policy (`src/core/action-policy.ts`)

`evaluateAction({ kind, effects[], target?, node?, argv?, origin })` →
`{ level, decision, reason, impact }`. The level is computed only here — a `level`
or `decision` passed by a caller or a model is ignored.

| Level | Meaning | Decision | Examples (kinds / effects) |
|-------|---------|----------|----------------------------|
| L0 | read, measure, report | auto | `diagnose`, `lesen`, `melden` |
| L1 | reversible, own node | auto | `log-rotation`, `cache-leeren`, `endpoint-umschalten`, `self-heal-zyklus` |
| L2 | consequential | ask (button) | `install-katalog`, `dienst-neustart`, `config-aendern`, `geraet-einrichten`, `modell-wechseln`, `vm-starten/-stoppen/-snapshot`, `drucken`, `schalten`, `mail-senden` |
| L3 | dangerous | never (owner request: handoff, still nothing runs) | Nie-Liste: delete, firewall/SSH/sudoers, credentials, disable security, NAS restart, DB migration |

Fixed rules: unknown kind or unknown effect → L2 ask; physical and outward kinds are
at least L2; L1 on a foreign node becomes L2; L3 never gets a button.
The unified Nie-Liste lives here: effects (formerly `self-heal.ts`, still exported
there as `NIE_LISTE`), kind patterns of the cards **and** of the learning module
(union — only stricter, never looser), protected targets, and for commands the argv
rules of `src/install/never-list.ts`. Trust ladder (prepared): `trustEvidence(kind)`
counts successful runs without rollback; after 5 an L2→L1 *proposal* thought may
appear — never automatic, never for physical/outward/L3, and the level stays.

### Verantwortungen (`src/core/responsibilities.ts`)

Derived by fixed rules from existing measurements (no model decides):

| Rule | Source | Responsibility | Actions | Activation |
|------|--------|----------------|---------|------------|
| `knoten-gesund` | node profiles (own + mesh) | „Knoten X gesund halten“: self-check not critical, profile ≤ 2 h old | `diagnose`, `melden`, own node also `self-heal-zyklus` | automatic (L0/L1) + thought „Ich kümmere mich ab jetzt um …“ |
| `dienst-laeuft` | Nachtwache checks | „Dienst Y läuft“: check green | `diagnose`, `dienst-neustart`, `melden` | button (contains L2) |
| `geraet-ueberwachen` | devices set up in Wahrnehmen | „Gerät Z überwachen“: no open error event | `diagnose`, `melden` | automatic |
| `release-aktuell` | latest verified release thought | all nodes on that version or newer | `diagnose`, `melden` | automatic |
| `wiederholte-anfrage` | owner sessions (≥ 3 of the same topic in 14 days) | „X von mir aus im Blick behalten“ | `diagnose`, `melden` | always a proposal (ask) |

[Nein] on a proposal rejects it for good. `/arbeit pause <id>` / `weiter <id>`.
Stored in `.nova-data/responsibilities/responsibilities.json`.

### Missionen (`src/core/missions.ts`)

A violated active responsibility starts a mission (one open per responsibility,
24 h pause after blocked/failed) with a contract: done-when = its criteria, may = L0/L1
automatically, ask = L2 (card `mission-schritt`), never = L3. Steps come from a fixed
plan per rule (always a diagnosis first). Max 3 attempts (each starts with a fresh
diagnosis), budget: time, tool calls, cost 0. States: `geplant` → `in-arbeit` →
`wartet-auf-alfred` → (`Ja`: exactly this step runs, then the mission continues —
also after a restart) / (`Nein` or card expired: `blockiert`, handoff „bis hier
gekommen: …; brauche dich für: …“) → `abgeschlossen` | `fehlgeschlagen`. Persisted
atomically in `.nova-data/missions/missions.json`.

Execution only through registered step executors: `diagnose` (read-only),
`self-heal-zyklus` (the three self-heal recipes, needs `autonomy.selfHeal.enabled`),
`install-katalog` (install queue + signed ticket, after Ja), `geraet-einrichten`
(sensing `approveDevice`, after Ja). There is deliberately **no** executor for service
restart or release rollout yet: such a step ends as a handoff to Alfred.

Takt: sensing events (warning/urgent, errors, offline) trigger a debounced check;
the planner job `sys-verantwortungen` (or a timer without planner) is the fallback.

`/arbeit` (owner): In Arbeit / Geplant / Wartet auf Alfred / Blockiert /
Abgeschlossen (last 5) plus active responsibilities with erfüllt/verletzt.

## Phase 6d — Multi-Router and model control

Default: **off**. Without `routing.multi.enabled=true` the per-task rule table
R1–R8 (`src/routing/task-model-routing.ts`) decides exactly as before.

```json
"routing": { "multi": {
  "enabled": false,
  "cloudDailyBudgetEur": 0,
  "minSamples": 5,
  "cloudModels": [ { "provider": "anthropic", "model": "<model id>", "costEurPerCall": 0.02 } ],
  "costs": { "openai": 0.01 }
} }
```

- **Model register** (`src/routing/model-registry.ts`): one entry per runtime x node x
  model — vLLM and Ollama from the capability graph, Codex from `codex`, cloud models
  from `routing.multi.cloudModels` (listed only when a key is configured; only its
  presence is checked). Per entry: proven capabilities (capability probe, a validated
  Outcome-Ledger run of that task class, or the existing rule table for Codex — a model
  name never counts, "Erkannt ≠ nutzbar"), privacy class (`lokal` only for a local
  runtime on a known mesh node or a private host, everything else `cloud`), cost per
  call (0 local; cloud from config; unknown = `null` = expensive), success rate and
  latency per task class (Outcome-Ledger runs with `modelClass`; the Scout-Prüfsatz
  counts as general work), health (probe online/offline, Codex availability).
- **Router** (`decideMultiRoute`, extends the table): stage A hard filters that no model
  output can loosen — picture/private/memory content only `lokal`; non-owner only
  `lokal`; Codex only where R1–R8 picks Codex; other cloud models only within the daily
  budget (0 € = none; unknown cost refused); the needed capability must be proven.
  Stage B among the remaining endpoints with ≥ `minSamples` measurements for the task
  class: success rate, then latency, then cost. Without measurements the R1–R8 result
  stands (a table Codex pick stays until Codex itself has measurements). Decision,
  reason, basis and every candidate with its exclusion reason go to the Outcome-Ledger
  (`route.selected`).
- **Cleaned prompt for cloud** (`src/routing/cloud-prompt.ts`, mandatory): every cloud
  client (measured cloud choice, and Codex while the multi-router is on) is wrapped so
  each `complete` call drops all pipeline system messages (USER.md/MEMORY.md, journal,
  facts, user context) and the conversation history, keeps only the current task plus
  the current tool loop, scrubs private sections/tags and secrets, and never sends
  images. Allow-list: one neutral system prompt replaces everything.
- **Ollama control** (`src/routing/local-model-control.ts`): special models are loaded
  per task with `/api/generate` + `keep_alive` and unloaded with `keep_alive: 0`, only
  when the node profile shows enough free memory (reserve 4 GB, 16 GB on the vLLM node)
  and never on a vLLM node whose memory check is not `ok` (OOM 13.09.). A model missing
  on the node is never pulled by itself: `/api/pull` is L2 and becomes a Knopf-Karte
  (`ollama-pull`); only "Ja" pulls.
- **vLLM switch at the Spark**: plan + card only (`/modelle wechsel <aufgabe> <modell>
  [minuten]` → "Für Aufgabe X wäre Modell Y besser, Wechsel ~N min, Rückweg
  automatisch"). The recipe (measure → snapshot → switch → probe → automatic way back)
  runs through a host-agent port after "Ja"; in this build the production port is
  unwired, so "Ja" only confirms the plan and no vLLM is touched. `vllm:stoppen` stays
  on the Nie-Liste; wiring the real switch needs Alfred's decision on that boundary.
- **`/modelle`** (owner): register with capabilities and their evidence, privacy class,
  cost, health, measurements and the current choice per task class.
