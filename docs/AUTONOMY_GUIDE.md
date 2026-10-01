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
