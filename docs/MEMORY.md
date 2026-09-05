# Memory System Guide (v2.76)

Nova's multi-level memory architecture.

## Memory Assets and Loadouts

Nova 2.76 adds a governed catalog for reusable `chat-memory`, `skill`, `wiki`
and `code-graph` assets. This is a projection over Nova's canonical memory
governance, not a second database authority.

Every asset has an owner, version, lifecycle status, visibility, source and
bounded content. Loadout bindings target a principal, bot or Desktop topic
room. Only active assets readable by the current principal are projected into
the single canonical prompt path. Assets are never globally injected, and
Wiki/CodeGraph content should be retrieved through tools when it exceeds the
bounded loadout budget.

Nova Desktop exposes the catalog in **Gedächtnis**. Owners can create an asset
and equip it for the current room without slash commands. Removing an asset
from a room stops future prompt projection; it does not delete its source
memory or audit history.

---

## Overview

| Level | Storage | Purpose | Persistence |
|-------|---------|---------|-------------|
| **Short-term** | Session JSON | Current conversation | Session only |
| **Long-term** | LanceDB Vectors | Semantic knowledge | Permanent |
| **Instincts** | L23 JSON | Behavioral patterns | Permanent + decay |
| **Predictive** | Usage patterns | Model pre-warming | Permanent |
| **Dreams** | Reflector logs | Self-analysis results | Last 50 cycles |

---

## Short-term Memory (L06 Session)

Stored in `.nova-sessions/`:
- Per-user conversation history
- Entity tracking
- Max 50 messages per session (configurable)

---

## Long-term Memory (LanceDB)

Vector database for semantic search. Embeddings via `nomic-embed-text` or Gemini.

### Tools

```
remember  — Store information permanently
recall    — Semantic search across all memories
forget    — Delete a specific memory
```

### Memory Types

| Type | Description |
|------|-------------|
| `fact` | General knowledge |
| `preference` | User preferences |
| `correction` | Learned corrections |
| `insight` | Nova's own insights |
| `project` | Project context |
| `instinct` | Behavioral rule (L23) |

### Flow

```
User Input
    ↓
Generate Embedding (Ollama/Gemini)
    ↓
Vector Search in LanceDB (Top-K)
    ↓
Inject into context as "Erinnerungen"
    ↓
LLM uses memories in response
```

---

## L23 Instinct Layer

**Learns unconscious behavioral rules from corrections.**

When you correct Nova ("zu technisch!", "kürzer!", "auf deutsch!"), she detects patterns and builds instincts:

| Trigger | Rule | Category |
|---------|------|----------|
| "zu technisch" | Einfach sprechen | tone |
| "zu lang" | Max 3-4 Sätze | verbosity |
| "auf deutsch" | Immer Deutsch | language |
| "mach einfach" | Keine Rückfragen | behavior |

**Mechanics:**
- Strength: 0-100 (starts at 20, +10 per reinforcement)
- Decay: -5 per 14 Tage ohne Reinforcement
- Active threshold: ≥30 strength
- Auto-injected into system prompt

---

## Predictive Memory

Nova remembers WHEN you use WHICH model:

```
Mo-Fr 09:00 → gemma3:12b (85%)
Mo-Fr 14:00 → gemma3:4b (60%)
```

Pre-warms models 15 minutes before predicted need.

---

## Context Warming

During dream cycles, Nova pre-loads relevant documents into the vector cache based on predicted upcoming work context. Zero-latency first answer in the morning.

---

## Data Locations

| Data | Path |
|------|------|
| Sessions | `.nova-sessions/` |
| LanceDB | `.nova-lancedb/` |
| Vector Memory | `.nova-data/memory/` |
| Instincts | `.nova-data/instincts/` |
| Dream Results | `.nova-data/reflector/` |
| Predictive Patterns | `.nova-data/predictive/` |
| Red-Team Results | `.nova-data/red-team/` |
| Learned Solutions | `.nova-learning/` |
