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

## Main succession with full knowledge (2.88, opt-in)

When the Main fails, another owner-approved node takes over with the same
memory, connections, responsibilities, cards and configuration, and Telegram
moves with it. It reuses the existing Main lease (witness quorum or Supabase),
CL-07 epochs and fencing; there is no second election.

```json
{
  "mesh": {
    "succession": {
      "enabled": true,
      "mainEligible": true,
      "mainNodes": ["node-a", "node-b", "node-c"],
      "emergencyMaxMinutes": 240,
      "vacancyGraceSeconds": 20,
      "localPort": 3019
    }
  }
}
```

- **Owner decision per node.** With succession on, only nodes with
  `mainEligible: true` (or `NOVA_MAIN_ELIGIBLE=true`) and listed in
  `mainNodes` can become Main; every other node stays a worker
  (`src/mesh/succession-config.ts`). `mainNodes` is fixed on purpose so a
  shrinking discovery view never lowers the majority.
- **Journal** (`src/mesh/state-journal.ts`). Every state change is an
  AES-256-GCM encrypted, HMAC-authenticated, hash-chained entry, replicated to
  the other `mainNodes` and committed once a majority stored it. Each replica
  keeps an epoch high-water mark; a new term starts with a `term` entry, after
  which older epochs are rejected. The old Main's first write after the epoch
  change fences its writer for good. The key is derived from the shared HA
  state key (`NOVA_HA_STATE_KEY`).
- **Successor** (`src/mesh/succession.ts`, `src/mesh/succession-runtime.ts`).
  On a vacancy the strongest reachable eligible node reads the logs of a
  majority (fewer: safe mode), raises the witness epoch floor above every
  epoch they saw, acquires the lease, restores the state, starts its term on a
  majority and opens the secret vault. Telegram starts only after that and
  sends once: "Ich bin jetzt auf X umgezogen, alles da." (nothing is
  announced when the same node simply restarts).
- **Secrets on every node** (`src/mesh/secret-vault.ts`). Telegram and
  connector tokens are encrypted once; the data key is split k-of-n (k =
  majority of all nodes, Shamir) and each node holds one share sealed to its
  own X25519 key. A holder releases its share only after its own view of the
  coordinator confirms the requester holds the Main lease in exactly that
  epoch, and never for an epoch below its high-water mark. Below three nodes
  the share path is disabled and only the owner code opens the vault.
  Plaintext exists only in memory and is wiped on step-down.
- **No majority: safe mode.** Read only, nothing is sent; the lease layer
  refuses acquisition and effects stay fenced.
- **Owner emergency code** (`src/mesh/emergency-code.ts`). Set in advance; the
  node stores only a salted scrypt hash. The check is constant-time, does the
  same work without a configured code, locks after 5 wrong attempts and never
  logs or returns the code. With the right code, an eligible node in safe mode
  becomes emergency Main (witness coordination only) for at most
  `emergencyMaxMinutes`, with an epoch above every known term (token
  `nova-main:e<epoch>:<node>`); the next majority term lies above it. As soon
  as a majority is reachable again the emergency term ends (or turns into a
  regular term if this node wins the majority). The code also opens the
  vault's owner wrap.
- **Local owner door.** In safe mode no Dashboard runs, so an eligible node
  listens on `127.0.0.1:<localPort>` (direct loopback only):
  `GET /nachfolge`, `POST /nachfolge/notfall {code}`,
  `POST /nachfolge/notfallcode {code, current?}` (owner token required when
  `NOVA_DESKTOP_API_TOKEN` is set; replacing a code needs the current one).
- **Mesh messages.** `succession.request` / `succession.response` (role
  `system`, targeted only): journal export and delivery (writer bound to the
  sending node), share release, share public key, vault distribution
  (`distributeSecretVault`, acting Main only, verified by each receiver).

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
