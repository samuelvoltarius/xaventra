# Nova Mesh Network (v2.72)

## Architecture

Nova's mesh distributes intelligence across multiple edge devices via Tailscale VPN:

```
┌─────────────────────────────────────────────────────────┐
│ MASTER (Windows PC)                                     │
│   ├── WebSocket Server :9090 (Event Hub)               │
│   ├── HTTP API :18789 (Dashboard + REST)               │
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
| `mesh:skill_sync` | Skill Dist. | Notify nodes about new skills |
| `office:person_detected` | Jetson | Camera person detection |
| `system:health` | Any node | Health status broadcast |

---

## Skill Distributor (`src/mesh/skill-distributor.ts`)

Sign and deploy custom tools to all mesh nodes automatically.

### Flow

```
approved Forge artifact → packageSkill()
    ↓
native sandbox + benchmark + canary evidence
    ↓
Owner approval → sign exact SHA-256 artifact
    ↓
tar pipe over SSH → Pi5 + Jetson
    ↓
Verify deployment
```

### Usage

```typescript
import { deploySkill, deployAllSkills } from './mesh/skill-distributor.js'

// Deploy single skill
await deploySkill('tapo-camera-analyzer')
// → Signs → tar+ssh to Pi5 → tar+ssh to Jetson

// Deploy all skills
await deployAllSkills()
// → { total: 5, deployed: 4, failed: 1 }
```

**Security:** Skills that fail the AST security check are **BLOCKED from deployment**.

---

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
