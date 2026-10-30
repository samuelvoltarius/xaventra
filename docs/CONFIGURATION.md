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

Model routing by measurement has one path: the multi-router
(`routing.multi.enabled`, off by default; R1–R8 rule table otherwise). Its
success rates come only from real owner runs judged by the Execution Kernel —
Doctor, autonomy, internal, benchmark and other non-owner runs never count.
Since 2.84.0 there is no separate shadow outcome router and no
`NOVA_OUTCOME_ROUTER_MODE`; the validated samples remain the learning curve
and the desktop training status.

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

- `sensing.scout` (Späher, only an explicit `true`, per node): this mesh worker searches **its own**
  networks (the same bounded discovery as Main: fixed ports, mDNS, SSDP, Tuya; private subnets of
  its own interfaces up to /24 and its own tailnet only) and sends the findings as a signed
  `discovery.report` to Main. Main accepts reports only from configured peers with role
  `worker`/`system`, applies the same gate (net-scope: never public, only inside the reported private
  subnet) and records accepted devices with `seenBy`; cards and connections stay on Main. Example for
  the NAS in the home LAN: `"autonomy": { "sensing": { "enabled": true, "scout": true } }`.
  Since 2.91.2 `scout: true` alone is enough on a worker: it implies `sensing.enabled` and
  `sensing.discovery.enabled` unless either is explicitly `false`, with gentle worker defaults
  (`discovery.firstRunDelaySec` 300, `intervalHours` 6, `ratePerSec` 10, `concurrency` 4; explicit values
  win). A scout that does not start logs one line with the reason (`Späher steht an, startet nicht: …`).
  Docker bridges (`docker0`, Synology `docker-<hex>`, `br-<hex>`, `veth*`, `virbr*`) are never scanned.
- `sensing.discovery.subnets` (2.91.2, optional): allowlist of CIDRs, e.g. `["192.168.0.0/24"]`. When set,
  discovery searches **only** inside it, intersected with the own private subnets (a narrower entry narrows
  them); the tailnet only when an entry lies in it. It never widens the scope: public, foreign or malformed
  entries are ignored with a log line (`discovery.subnets: <entry> ignoriert (<Grund>)`).

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

### Context per task (2.90)

```json
{
  "context": {
    "metrics": "on",
    "taskPrompt": "shadow",
    "lagebild": "shadow"
  }
}
```

| Key | Values | Default | Effect |
|-----|--------|---------|--------|
| `context.metrics` | `on` / `off` | `on` | One line per turn in `.nova-data/context-metrics.jsonl` (sizes and block headings only, never text); `/kontext` |
| `context.taskPrompt` | `off` / `shadow` / `on` | `shadow` | Task prompt: only the core blocks plus the blocks that match the turn's tool route. `shadow` measures it and still sends the old prompt; `on` sends it. The prompt budget stays as safety net. |
| `context.lagebild` | `off` / `shadow` / `on` | `shadow` | Measured self-image (node profile, peers, Proxmox pool, Kubernetes). `shadow`: only `/lage`; `on`: protected prompt block that replaces the fixed soul text „DEINE UMGEBUNG“, „MESH NETZWERK“, „NODE UPDATES“. |

The environment wins: `XAVENTRA_CONTEXT_METRICS`, `XAVENTRA_TASK_PROMPT`, `XAVENTRA_LAGEBILD`. Switching back is `off` plus a restart; no rollback needed.

`context.threads` (2.91.0, `XAVENTRA_THREADS`): `off` / `shadow` (default). Every owner message in a direct chat is assigned to a topic thread automatically (reply, open question or approval, correction, tool route, owner-profile entity, shared keywords, short follow-up; own threads named from content, merged, resting after 7 days); `shadow` measures it in `context-metrics.jsonl` (`threadKey`, `threadRule`, `foreignHistoryShare`) and in `/themen`, the history stays shared. Groups, guests, phone and system turns get no threads. No message text is stored in `.nova-data/topic-threads.json`.

Two capabilities of 2.90.0 are on by default and can each be turned off:

| Key | Environment | Effect when off |
|-----|-------------|-----------------|
| `infra.kubernetes.testPods: false` | `XAVENTRA_K8S_TEST_PODS=off` | `cluster_test_pod` is neither offered nor executed |
| `mesh.desktopInput: false` | `NOVA_MESH_DESKTOP_INPUT_ENABLED=false` | `mesh_desktop_input` refuses on Main (the node keeps its own opt-in) |

---

## Environment Variables

```bash
TELEGRAM_BOT_TOKEN=your-token
TELEGRAM_ADMIN_CHAT_ID=your-chat-id
OLLAMA_HOST=http://localhost:11434
HETZNER_API_TOKEN=your-token        # For Auto-Provisioner
NOVA_DOCKER_HOST=http://host:2375   # For Docker provisioning
NOVA_CREDENTIAL_KEY_FILE=/var/lib/xaventra-native-<ver>-<date>/secrets/credential.key  # vault key outside the data tree
```

### Images to the vision model (30.10.2026)

Local stills reach MiniMax only through `analyze_image` and one gate
(`src/media/image-source-policy.ts`): files in `.nova-vision/mesh-captures` from released
nodes (`XAVENTRA_VISION_NODES`, comma list, default `xaventra-lab`) and `.nova-vision/kamera`;
PNG/JPEG up to 8 MB; no link, no free path. Images of the car (`auto/`) and local desktop
screenshots are refused. Without a MiniMax key the answer says so; such an image never goes to
another service. `minimax_vision` takes https addresses only.

### Panoptes still on a guard event (30.10.2026)

`"autonomy": { "panoptes": { "enabled": true, "urls": ["http://<car-tailscale-address>:8180"] } }` (default off; `urls` is a list because the car can have two tailnet addresses,
Main only). `/panoptes koppeln` (owner) requests a pairing of kind `dienst` and shows the check number;
the owner allows it at the car and switches on „Standbild bei Ereignis“ there. The JWT stays sealed in
the vault (written and read back before success is reported, because Panoptes hands the JWT out once) and renewed daily. Stream drops are normal: it reconnects with a growing pause up to 5 minutes and logs at most once an hour. Then one still per `ereignisId` is fetched, kept at most 72 h in `.nova-vision/auto`,
evaluated with MiniMax and sent to the owner. The client (`src/sensing/panoptes-client.ts`) has a hard
path allowlist: pairing, `/api/ha/v1/ereignisse`, `/api/waechter/standbild/<id>`,
`/api/surveillance/status`, `/api/sitzung/erneuern|abmelden`. No clips, recordings, vehicle endpoints
or coordinates. An event without `ereignisId` is logged honestly and nothing is fetched.

### Cameras (30.10.2026)

The search recognises cameras without login. After the owner's Ja on the card, user and password
are entered only in the desktop app (Verbindungen) and stay sealed in the vault. `kamera_standbild`
fetches one still on request: the login goes only to the node that found the camera, only for that
address, in a signed ephemeral `capture.request` over the encrypted direct mesh path; without such a
path it ends with an error. The still lies at most 24 h in `.nova-vision/kamera`. No stream, no
sound, no polling. Only ONVIF for now; a pure RTSP camera gets an honest answer.

### Vault key (30.10.2026)

All sealed stores (Tresor `secrets/tresor`, connection access data `secrets/connections`,
Hue/Tuya keys `secrets/smart-devices`, sealed fields of `auth.json`) use **one** key
(AES-256-GCM, `src/secrets/local-sealed-store.ts`). It must not lie in the data tree that is
copied for backups, peer swaps and the rollback copy of the runtime. Sources, in this order:

1. systemd `LoadCredential=xaventra-credential-key:<path>` (read via `$CREDENTIALS_DIRECTORY`, never created).
2. `NOVA_CREDENTIAL_KEY_FILE` — absolute path **outside** the runtime/data tree; created once (0600) if missing.
   Native Main: `<root>/secrets/credential.key` next to `service.env`; the native update copies
   `<oldRoot>/secrets` and rewrites `oldRoot → root` in `service.env`, so the key moves with the
   secrets folder, never into the runtime copy.
3. Docker peers: mount a secret at `/run/secrets/xaventra-credential-key` (read only), e.g.
   `docker run --mount type=bind,src=/etc/xaventra/credential.key,dst=/run/secrets/xaventra-credential-key,readonly`.
   Kubernetes (2.91.2): Helm value `vaultKey.existingSecret` (key `vaultKey.key`, default `credential.key`)
   mounts the Secret read-only (0400, group = `fsGroup`) at the same path in every worker and an in-cluster
   Main; see `docs/KUBERNETES.md` → Secrets per Pipe. A node whose stores are already sealed needs the key
   they were sealed with.
4. Without any of them the old per-directory key next to each store is used and the daemon warns at start.

At start, plaintext secret files are sealed (backup, seal, read back) and, with an external key,
every sealed store is re-sealed with it and read back; the old in-tree `.credential-key` files are
removed only when nothing failed. A store that opens with no known key stays untouched. Only ids
and paths are logged, never values.

---

## Model Options

| Provider | Model | Speed | Quality |
|----------|-------|-------|---------|
| Antigravity | `gemini-3-flash` | ⚡⚡⚡ | ★★★★ |
| Antigravity | `gemini-3-pro` | ⚡⚡ | ★★★★★ |
| Ollama | `gemma3:4b` | ⚡⚡⚡ | ★★★ |
| Ollama | `gemma3:12b` | ⚡⚡ | ★★★★ |
| Ollama | `gemma3:27b` | ⚡ | ★★★★★ |

### A self-registered provider as the main model (2.89.8)

An OpenAI-compatible provider you added with `register_llm_provider`
(stored in `.nova-data/external-providers.json`, key in the sealed provider
vault under `auth:llm-provider:<name>`) can be the **primary** model. It is
called at exactly its own `baseUrl` with its own key; nothing is sent to
another server, and a failure never sends the key anywhere else.

```json
{
  "provider": "acme",
  "model": "acme-chat-pro",
  "providers": {
    "acme":  { "apiKeyRef": "auth:llm-provider:acme", "baseUrl": "https://api.example.com/v1", "enabled": true },
    "local": { "baseUrl": "http://192.0.2.10:8000/v1", "enabled": true }
  },
  "fallbackModels": []
}
```

- `model` must be one of the provider's registered `models`; the provider must
  be enabled and have a key in the vault, otherwise it is refused.
- Order when the primary fails (timeout, 5xx, network): the local chain
  (`providers.local`, a remote endpoint is probed quickly and held when dead)
  and then the models listed in `fallbackModels`.
- A provider name that is neither built in (`local`, `openai`, `anthropic`,
  `minimax`, ...) nor registered is **refused at startup** (log line
  `refused (fail-closed)`) and the local chain is used. It is never built as
  the `openai` client. `openrouter` and `groq` are used only through their own
  `baseUrl` (default: their public API) and need a key and an explicit `model`.

---

## Special Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Nova's personality (editable!) |
| `.nova-gateway-token` | Auto-generated Bearer token |
| `nova.config.node.json` | Edge node config |
| `.nova-data/` | All persistent data |
