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
