# Nova Security Architecture (v2.72)

## 5-Layer Security Model

```
Request
  │
  ├─ Layer 1: SSRF Guard           → Blocks private IPs / cloud metadata
  ├─ Layer 2: Gateway Auth         → Bearer token on HTTP API
  ├─ Layer 3: Tool Validator       → 4-level shell injection detection
  ├─ Layer 4: Code Guardian        → AST + anomaly + signed patches
  └─ Layer 5: Red-Team (L22)       → Autonomous self-hardening
```

---

## Layer 1: SSRF Guard (`src/security/ssrf-guard.ts`)

Prevents Server-Side Request Forgery. Skills/tools can only access explicitly allowed local IPs.

**Blocked by default:**
- RFC 1918: `10.x`, `192.168.x`, `172.16-31.x`
- Tailscale CGNAT: `100.64-127.x`
- Cloud metadata: `169.254.169.254`, `metadata.google.internal`
- Link-local: `169.254.x`, `fe80::`
- IPv6 private: `fc00:`, `fd00:`

**Allowed (configurable):**
- `127.0.0.1` / `localhost`
- Pi5: `100.64.0.21`
- Jetson: `100.64.0.22`

```typescript
import { safeFetch, checkSSRF } from './security/ssrf-guard.js'

const result = checkSSRF('http://192.168.1.1/admin')
// → { allowed: false, reason: 'Lokale Adresse blockiert' }

await safeFetch('https://api.example.com/data')  // OK
await safeFetch('http://10.0.0.1/secret')        // THROWS
```

---

## Layer 2: Gateway Auth (`src/infra/gateway-auth.ts`)

Auto-generated Bearer token per node for HTTP API access.

- 64-byte hex token generated on first start
- Stored in `.nova-gateway-token` (chmod 600)
- Timing-safe comparison against oracle attacks

---

## Layer 3: Tool Validator (`src/validation/tool-validator.ts`)

4-level shell injection detection for `run_command`:

| Level | What it catches |
|-------|----------------|
| **1** | Destructive commands: `rm -rf /`, `format c:`, `mkfs` |
| **2** | Injection patterns: backtick subshells, `$()`, pipe-to-bash, base64-decode, reverse shells, SSH-key injection, SUID escalation |
| **3** | Suspiciously long commands (>500 chars) |
| **4** | Too many chained commands (>5 via `;`, `&&`, `\|\|`) |

---

## Layer 4: Code Guardian (`src/security/code-guardian.ts`)

Full code security pipeline for any code Nova creates or executes:

### AST Analyzer (`src/security/ast-analyzer.ts`)
- **Real AST** via `acorn` + `acorn-walk` (NOT regex!)
- Two-tier module system:
  - **Critical** (blocked): `child_process`, `vm`, `cluster`, `net`, `tls`, `dgram`, `repl`, `worker_threads`
  - **Warning** (flagged): `fs`, `os`, `path`, `http`, `https`, `http2`

### Detection Capabilities
- Direct `eval()` calls
- `Function()` constructor
- `setTimeout` / `setInterval` with string args
- `process.exit()` calls
- Dynamic property access on `globalThis`
- Prototype pollution (`__proto__`)
- Network access via `fetch()`

### Signed Patches
Every code change gets a signature:
- SHA-256 hash of content
- Confidence score (0-1)
- Source tracking (user, auto, mission)

### Kill-Switch
Emergency stop for all autonomous code execution. Activated manually or by anomaly detection.

---

## Layer 5: Red-Team (`src/security/red-team.ts`)

Autonomous self-hardening during dream cycles. Nova tests her own guards with 20+ attack vectors:

| Category | Examples |
|----------|---------|
| **eval-bypass** | String concatenation on globalThis, Array constructor chain |
| **import-bypass** | Split string require, template literal, variable-based |
| **sandbox-escape** | globalThis dynamic access, prototype pollution, constructor chain |
| **injection** | Semicolon chaining, backtick subshell, pipe-to-bash, base64 |
| **obfuscation** | Hex escapes, String.fromCharCode, reversed strings |

Each bypass found reduces the security score. Results saved to `.nova-data/red-team/`.

---

## Security Events Flow

```
New Skill/Tool Created
    ↓
AST Analyzer → parse with acorn
    ↓
Critical module? → BLOCK
Warning module? → FLAG for review
    ↓
Sandbox Test → vm.runInNewContext (timeout: 2s)
    ↓
Sign Patch → SHA-256 + confidence score
    ↓
Decision: allowed + signature OR blocked + reason
```
