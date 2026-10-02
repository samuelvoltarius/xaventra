# Configuration Reference (v2.72)

## MCP servers (2.71+)

Nova loads optional MCP servers from `mcp.servers`. Use `transport: "stdio"`
with `command` and an argument array for local servers, or `transport: "http"`
with an HTTPS `url` for Streamable HTTP. Plain HTTP is rejected for remote
hosts; it can only be enabled explicitly for loopback development with
`allowInsecureHttp: true`. `allowedTools`, `deniedTools`, `requireApproval` and
`reconnect` are enforced before MCP tools enter Nova's canonical registry.

OAuth implementations are injected locally by node. Tokens and OAuth provider
state must never be placed in `xaventra.config.json`, Memory, Supabase or Mesh.

Outcome routing remains shadow-only unless `NOVA_OUTCOME_ROUTER_MODE=active`.
Active mode still requires enough independently validated production samples
for the requesting principal. Benchmark, fixture, synthetic, model-response-only
and other users' outcomes never make a route eligible. Optional
`NOVA_OUTCOME_ROUTER_ACTIVE_TASKS` limits activation to comma-separated task
types and `NOVA_OUTCOME_ROUTER_CANARY_PERCENT` sets a deterministic canary.

`NOVA_BLUE_TEAM_LOG_ROOTS` may add comma-separated, explicitly authorized roots
for defensive log triage. The default roots are the Nova workspace,
`.nova-data` and `.nova-logs`.

All configuration options for Nova.

---

## `xaventra.config.json`

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | string | ❌ | Bot name (default: `Nova`) |
| `emoji` | string | ❌ | Bot emoji (default: `✨`) |
| `version` | string | ❌ | Current version |
| `mode` | string | ✅ | `master` or `mesh-node` |
| `provider` | string | ✅ | LLM provider (`google-antigravity`, `gemini`, `ollama`) |
| `model` | string | ✅ | Model ID (e.g. `gemini-3-flash`, `ollama:gemma3:12b`) |
| `internalModel` | string | ❌ | Model for internal tasks (`auto` = auto-select) |
| `fallbackModels` | string[] | ❌ | Fallback models on error |

### Channels

```json
"channels": {
  "telegram": {
    "enabled": true,
    "token": "BOT_TOKEN",
    "allowFrom": ["123456789", "987654321"]
  },
  "whatsapp": { "enabled": false },
  "discord": { "enabled": false, "token": "DISCORD_TOKEN" },
  "cli": { "enabled": true }
}
```

Telegram `allowFrom` entries are numeric Telegram **user** IDs (digit strings).
Usernames match only when written explicitly as `@name` (mutable, not
recommended); other non-numeric entries match nothing. An unreadable or
malformed config is treated as restricted, not as open.

### Dashboard

```json
"dashboard": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 3011
}
```

The dashboard port serves the same UI as the Desktop app (`desktop/renderer`,
see [DASHBOARD.md](DASHBOARD.md)). Its only data API is `/api/desktop/*`; every
API request needs a token, unknown `Host` names (DNS rebinding) and foreign
`Origin`s are refused, and owner views require `NOVA_DESKTOP_API_TOKEN`. Keep
`host` on loopback or the Tailnet address; never bind it publicly.

### Telemetry (OpenTelemetry)

```json
"telemetry": {
  "enabled": false,
  "endpoint": "http://100.64.0.12:4318",
  "fallbackEndpoints": ["http://192.0.2.12:4318"],
  "serviceName": "nova",
  "exportIntervalMs": 15000
}
```

### Memory

```json
"memory": {
  "maxShortTermMessages": 50,
  "learningEnabled": true,
  "learningUrl": "http://192.0.2.12:8200/rest/v1"
}
```

### Autonomy

```json
"autonomy": {
  "selfThinkEnabled": true,
  "selfThinkMaxPerHour": 2,
  "socialCheckIns": false,
  "triggers": {
    "dream-cycle": false
  },
  "quietHours": { "enabled": true, "start": 22, "end": 7 },
  "thresholds": { "disk": { "warnPercent": 90, "critPercent": 95, "minFreeGB": 5 }, "memory": { "warnPercent": 90, "critPercent": 95 } }
}
```

- `quietHours`: the one quiet-hours definition for every owner message (planner thoughts, loop, messenger, sensing).
- `thresholds`: the one disk/RAM threshold definition for L0, L21, node self-check, Nachtwache (unless a check sets its own), self-heal and the Wächter RAM forecast. On a vLLM node (detected from the node profile or a running vLLM process; force with `memory.vllmNode`) the RAM percentage is no finding, because vLLM reserves GPU unified memory permanently: a warning needs available memory below `memory.vllmMinAvailableMB` (default 4096, critical below half), swap growing by `memory.vllmSwapGrowthMB` (default 1024) between checks, or an OOM kill (critical on every node).

`socialCheckIns` and `dream-cycle` are opt-in. Operational events are handled
separately and may notify only when their producer is trusted or supplies a
fresh Outcome/Tool/Health/Mesh/Trace/Doctor evidence reference. Generic LLM
reflections are never sufficient notification evidence.

### Nova 2.70 autonomy and learning state

Nova persists the closed-loop state below under the configured Nova data and
learning roots:

- `goals.json`: user-scoped goals, dependencies, deadlines and next actions.
- `beliefs.json`: claims with provenance, confidence, expiry and counterevidence.
- `operational-events.json`: evidence-gated event initiative and deduplication.
- `self-doctor/failure-research.json`: Doctor research and PATCH_GATE stages.
- `regression-cases.json`: quarantined production failures awaiting an isolated
  test and a passing benchmark.
- `learning/procedures.json`: the one procedure store (verified solutions, per user).
- `forge/werkzeuge.json`: self-built tools of the Werkzeug-Schmiede (code, manifest,
  tests, versions, counters); see [TOOL_FORGE.md](TOOL_FORGE.md).

These files contain governed state and evidence references, never OAuth tokens,
API keys or raw tool output. Active Outcome routing remains sample-gated and
ignores benchmark runs.

### Mesh Nodes

```json
"nodes": [
  {
    "name": "Pi5",
    "host": "xaventra@100.64.0.21",
    "role": "edge",
    "runtime": "ollama"
  },
  {
    "name": "Jetson",
    "host": "xaventra@100.64.0.22",
    "role": "edge",
    "runtime": "ollama"
  }
]
```

For high availability, the current fenced Main may hand leadership to the
strongest healthy node only when no release, mission, approval, or Outcome run
is active:

```json
"mesh": {
  "mode": "ha",
  "preferStrongestMain": true
}
```

Planned handover requires `sql/mesh-coordination-v4.sql`. Without the
transactional coordinator RPC Nova keeps the current Main and fails closed.

A single node must declare itself with `"mesh": { "mode": "standalone" }`;
without that declaration and without a reachable coordinator a node does not
become local leader (split-brain guard).

Direct-mesh peers must carry the peer's `publicKey` (PEM printed by
`npm run mesh:identity` on that peer); key-less peers are rejected unless
`mesh.security.allowTofu` is explicitly `true`. Roles are fail-closed: a peer
without `roles` only gets `worker`; grant more only explicitly:

```json
"mesh": {
  "mode": "direct",
  "direct": {
    "enabled": true,
    "peers": [
      { "nodeId": "nova-worker-1", "url": "http://100.64.0.10:9091",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
        "roles": ["system", "worker"] }
    ]
  }
}
```

---

## Environment Variables

```bash
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_ADMIN_CHAT_ID=your-chat-id
OLLAMA_HOST=http://localhost:11434
HETZNER_API_TOKEN=your-token        # For Auto-Provisioner
NOVA_DOCKER_HOST=http://host:2375   # For Docker provisioning
```

---

## Model Options

| Provider | Model | Speed | Quality |
|----------|-------|-------|---------|
| Antigravity | `gemini-3-flash` | ⚡⚡⚡ | ★★★★ |
| Antigravity | `gemini-3-pro` | ⚡⚡ | ★★★★★ |
| Ollama | `gemma3:4b` | ⚡⚡⚡ | ★★★ |
| Ollama | `gemma3:12b` | ⚡⚡ | ★★★★ |
| Ollama | `gemma3:27b` | ⚡ | ★★★★★ |

---

## Special Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Nova's personality (editable!) |
| `.nova-gateway-token` | Auto-generated Bearer token |
| `nova.config.node.json` | Edge node config |
| `.nova-data/` | All persistent data |
