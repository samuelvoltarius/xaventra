# Self-Update & Evolution System (v2.72)

Nova's autonomous code improvement system with 5-layer security.

---

## Overview

Nova can propose, create, and deploy improvements to herself:

```
Identify Improvement
    ↓
Code Guardian: AST Security Check
    ↓
Signed Patch (SHA-256 + confidence)
    ↓
Sandbox Test (vm.runInNewContext, 2s timeout)
    ↓
Apply + Build Check
    ↓
Auto-Rollback on failure
```

---

## Security Pipeline

Every self-update goes through:

| Guard | What it does |
|-------|-------------|
| **AST Analyzer** | Parse code with acorn — block dangerous modules |
| **Code Guardian** | Anomaly detection, signed patches |
| **Sandbox** | Isolated execution test |
| **Kill-Switch** | Emergency stop for all autonomous code |
| **Rollback** | Automatic revert on build failure |

---

## Self-Evolution (L17)

Nova can create new tools at runtime:

```
User: "Erstelle ein Tool das Tapo-Cam Logs analysiert"
    ↓
Nova writes JavaScript tool code
    ↓
AST security check → PASS
    ↓
Tool registered in runtime
    ↓
Skill Distributor → deploy to all mesh nodes
```

### Dead-End Detection
L17 prevents infinite loops:
- Max 20 attempts per task
- 10-minute timeout per approach
- Tracks failed approaches to avoid repeating

---

## Proposal Types

| Type | Description |
|------|-------------|
| `bugfix` | Fix a detected bug |
| `feature` | New capability |
| `optimization` | Performance improvement |
| `refactor` | Code cleanup |

---

## Dream-Time Code Review (NEW)

During idle dream cycles, the Subconscious Reflector (L21):
1. Finds all code changed in the last 24 hours
2. Runs full AST deep scan (no time pressure)
3. Reports findings via Wake-up Call (Telegram)

---

## Red-Team Self-Hardening (NEW)

During dreams, Nova tests her own security guards with 20+ attack vectors. If bypasses are found, she reports them and suggests new guard rules.

---

## Commit Format

```
[Nova Auto] type: description
```

Example:
```
[Nova Auto] bugfix: add null-check to getEmbedding
```
