# Xaventra Mesh Network

## Witness-governed mission checkpoints

In `mesh.coordination.mode = "witness"`, native mission checkpoints use the
same three authenticated witness endpoints as mission leases. A checkpoint
write succeeds only while at least two witnesses independently confirm the
requesting node and exact lease epoch. A promoted successor reads only payloads
whose exact ID and SHA-256 hash agree on two witnesses. Stale holders cannot
write or read after the epoch advances.

This makes checkpoint storage part of the fencing boundary instead of relying
only on a pre-write authority check. Witness credentials remain node-local
configuration and are never written into checkpoints, receipts or memory.

Other coordination modes retain the encrypted shared-memory transport. A
production HA claim still requires independent witness hosts, controlled
network loss and physical-node takeover evidence.

## Capability Graph convergence

The Capability Graph is the canonical shareable inventory of node hardware,
runtimes, models, tools and measured availability. Nodes reconcile runtime
observations individually rather than replacing an entire node record. A
removal tombstone suppresses observations verified at or before the removal;
a later successful probe may advertise a restarted runtime with the same ID.
This ordering survives process restart and rejects delayed predecessor state.

The graph is not a credential store. Its persistence and replication boundary
removes password, token, API-key, private-key, authorization, cookie and
credential fields as well as URL user information and secret query parameters.
Only public status such as `available` or `authenticated` may be shared. Local
credentials remain scoped to the user and node that owns them.

## Mesh brain: who can do what, and where a task goes

Every node gets a strength profile without any configuration
(`src/mesh/node-strengths.ts`). It is derived only from data the mesh already
signs: the node profile (cores, RAM, GPU and VRAM, services, tools), the
Capability Graph (running runtimes and their loaded models), the live load on
the 30 s heartbeat (CPU per core, free RAM, cached GPU utilisation, free disk)
and the measured heartbeat round trip (latency). A peer without a signed
heartbeat for three minutes counts as offline.

`rankNodes(skill, nodes)` is pure and deterministic and returns one short
human reason, for example `gpu-box: GPU frei, Modell qwen3 geladen`. The task
router (`mesh-router.ts`), the prompt hint, `spawn_subagent mesh_node="auto"`,
`mesh_route` and `mesh_scan` all use this one source; there is no fixed node
list, no ping and no SSH. Model advice comes from the one catalog
(`model-recommender.ts`); nothing is installed automatically.

The owner question "Was kann welcher Knoten?" is answered by `mesh_strengths`
as one line per node.

## Mesh Git: work data travels with the task

The Main keeps bare repositories under `<data dir>/mesh-git/<name>.git`
(`src/mesh/mesh-git.ts`). `mesh_repo_task` publishes a local repository (or
uses the mesh repo's `main`), sends exactly that commit as a bounded git
bundle (8 MB) to the chosen or strongest node, lets a subagent work in
`mesh-work/<id>` there, takes the changes back as a bundle and stores them as
branch `mesh/<node>/<id>`. `main` is never changed by a node; the work
directory is always removed afterwards.

Transport is the existing signed mesh path only: typed `git.request` /
`git.response`, Main fence, privileged roles, and like camera captures only
over a live encrypted direct or local connection (never outbox, Supabase or
relay). No node needs a git server, SSH key or extra port. git runs without
shell, prompts, global/system config, hooks or network protocols. Bundle hash,
ancestry from the delivered commit and a secret scan of the change are checked
on both sides. A delegated agent gets read tools by default; write tools only
where `mesh.security.allowedTools` already allows them.

## Architecture

Nova's mesh distributes intelligence across multiple edge devices via Tailscale VPN:

```
┌─────────────────────────────────────────────────────────┐
│ MASTER (Windows PC)                                     │
│   ├── WebSocket Server :9090 (Event Hub)               │
│   ├── Desktop-API + Oberfläche :3011                  │
│   ├── All 23 Layers active                             │
│   ├── Heartbeat: 30s (Supervisor) + 60s (Mesh Registry)│
│   └── VRAM Manager + Predictive Provisioning           │
│                                                         │
│ EDGE: Pi5 (100.64.0.21)                               │
│   ├── WebSocket Client → Master:9090                   │
│   ├── Ollama (CPU only)                                │
│   ├── Receives signed skills from Master               │
│   └── Heartbeat → Supabase + local registry             │
│                                                         │
│ EDGE: Jetson Orin Nano (100.64.0.22)                 │
│   ├── WebSocket Client → Master:9090                   │
│   ├── Ollama (8GB VRAM GPU)                            │
│   ├── Vision (moondream)                               │
│   └── Receives signed skills from Master               │
│                                                         │
│ BACKEND: Hetzner (192.0.2.12)                      │
│   ├── Supabase/Postgres (memory)                       │
│   └── OTel Collector (telemetry)                       │
└─────────────────────────────────────────────────────────┘
```

---

## WebSocket Event Hub (`src/mesh/event-hub.ts`)

Real-time Pub/Sub between all nodes. Replaces polling with instant events.

### Usage

```typescript
import { emit, on, initHub } from './mesh/event-hub.js'

// Subscribe to events
on('office:person_detected', (event) => {
  console.log(`Person detected by ${event.source}!`)
})

// Wildcard subscription
on('office:*', (event) => {
  console.log(`Office event: ${event.type}`)
})

// Publish events (broadcast to all nodes)
emit('mesh:model_loaded', {
  model: 'gemma3:12b',
  node: 'jetson',
  vram_used: '7.2GB'
})
```

### Built-in Events

| Event | Source | Description |
|-------|--------|------------|
| `mesh:pre_warm` | Predictive | Tell nodes to pre-warm models |
| `mesh:compute_request` | Provisioner | Request compute from nodes |
| `office:person_detected` | Jetson | Camera person detection |
| `system:health` | Any node | Health status broadcast |

---

## Skill distribution

There is none. The former `src/mesh/skill-distributor.ts` was never wired and was
removed in P9. Self-built tools live only on the Main (Werkzeug-Schmiede,
[TOOL_FORGE.md](TOOL_FORGE.md)); workers build nothing.

## VRAM Manager (`src/layers/vram-manager.ts`)

Prevents OOM crashes by managing GPU memory across devices:

```typescript
import { ensureVRAMForModel, getVRAMStatus } from './layers/vram-manager.js'

// Check before loading
const result = await ensureVRAMForModel('gemma3:12b')
// → Unloads LRU models if needed
// → { ready: true, unloaded: ['old-model'], freeVRAM: 4.2 }

// Get current status
const status = getVRAMStatus()
// → { total: 8192, used: 5800, free: 2392, models: [...] }
```

---

## Predictive Provisioning (`src/layers/predictive-provisioning.ts`)

Learns usage patterns and pre-warms models before you need them.

### Features
- Records model usage events (day + hour + model + context)
- Analyzes patterns (min 2 occurrences, 40%+ confidence)
- Pre-warms most confident model 15 minutes before predicted need
- **Context Warming**: Pre-loads relevant documents into vector cache
- **Mesh-Aware**: Notifies edge nodes to warm up via Event Hub

### Example Patterns

```
Mo-Fr 09:00 → gemma3:12b   (85% confident) → GAEB project
Mo-Fr 14:00 → gemma3:4b    (60% confident) → casual chat
Sa    20:00 → gemma3:12b   (70% confident) → coding session
```

---

## Auto-Provisioner (`src/mesh/auto-provisioner.ts`)

Just-in-time computing for tasks that exceed current node capacity.

### Providers

| Provider | Type | Use Case |
|----------|------|----------|
| **Mesh** | Delegation | Small tasks → delegate to available node |
| **Docker** | Container | "Der Dicke" (ProLiant) → spin up container |
| **Hetzner** | Cloud VM | GPU/heavy tasks → cx22-cx52 instances |

### Flow

```
Heavy Task Detected
    ↓
selectProvider() → GPU needed? → Hetzner
                 → Large RAM? → Docker
                 → Small? → Mesh delegation
    ↓
Provision → Execute → Auto-Destroy (cost control!)
```

---

## Deployment

### Quick Deploy to All Nodes

```bash
# From master (requires Git Bash on Windows)
tar czf - src/ package.json scripts/ SOUL.md | \
  ssh xaventra@100.64.0.21 'cd ~/nova-core && tar xzf - && bash scripts/start-edge-daemon.sh'

tar czf - src/ package.json scripts/ SOUL.md | \
  ssh xaventra@100.64.0.22 'cd ~/nova-core && tar xzf - && bash scripts/start-edge-daemon.sh'
```

### Check Node Status

```bash
# Pi5
ssh xaventra@100.64.0.21 'tail -20 /tmp/nova-node.log'

# Jetson
ssh xaventra@100.64.0.22 'tail -20 /tmp/nova-node.log'
```

---

## Heartbeats (NOT the Reflector!)

Two separate systems — don't confuse them:

| System | Interval | Purpose |
|--------|----------|---------|
| **Heartbeat** (Supervisor) | 30s | "Am I alive?" — restart on freeze |
| **Heartbeat** (Mesh Registry) | 60s | "Are my nodes alive?" — Supabase sync |
| **Reflector** (Dreaming) | 30min (if idle >15min) | Deep analysis, Red-Team, wake-up calls |

These are complementary, not competing.
