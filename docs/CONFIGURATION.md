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
Active mode still requires validated production samples. Optional
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
    "allowFrom": ["CHAT_ID_1", "CHAT_ID_2"]
  },
  "whatsapp": { "enabled": false },
  "discord": { "enabled": false, "token": "DISCORD_TOKEN" },
  "cli": { "enabled": true }
}
```

### Dashboard

```json
"dashboard": {
  "enabled": true,
  "port": 18789,
  "password": "optional"
}
```

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
  "quietHours": { "enabled": true, "start": 23, "end": 7 }
}
```

`socialCheckIns` and `dream-cycle` are opt-in. Operational events are handled
separately and may notify only when their producer is trusted or supplies a
fresh Outcome/Tool/Health/Mesh/Trace/Doctor evidence reference. Generic LLM
reflections are never sufficient notification evidence.

### Nova 2.70 autonomy and learning state

Nova persists the closed-loop state below under the configured Nova data and
learning roots:

- `goals.json`: user-scoped goals, dependencies, deadlines and next actions.
- `beliefs.json`: claims with provenance, confidence, expiry and counterevidence.
- `causal-memory.json`: verified temporal outcome chains.
- `operational-events.json`: evidence-gated event initiative and deduplication.
- `self-doctor/failure-research.json`: Doctor research and PATCH_GATE stages.
- `regression-cases.json`: quarantined production failures awaiting an isolated
  test and a passing benchmark.
- `personal-skill-proposals.json`: skill maturity from proposal through sandbox,
  benchmark, canary, owner approval and active operation.

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
