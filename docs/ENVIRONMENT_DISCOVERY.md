# Automatic environment awareness

Xaventra's target is to reuse available AI software before asking users to install
more. Discovery and inventory are not authorization to change a device.

## Current data flow

The local/authorized-node AI scanner and mesh heartbeat reports feed the persisted
Capability Graph. Conversation context, capability lookup and the setup planner
read its current evidence, rather than a separate boot-time snapshot. Reads do
not start network scans or rewrite the graph. Periodic scanning remains separate.

From 2.78.9, runtime names and model lists remain distinct: a vLLM model is not
displayed as an Ollama model. Canonical setup candidates preserve each model's
endpoint, including custom model names, rather than matching a short name regex.

| Evidence | Meaning / limit |
|---|---|
| installed / stopped | Reported package or runtime inventory; not a usable endpoint. |
| running + fresh probe/heartbeat | Candidate for routing; not proof that a user is authenticated or a task succeeds. |
| expired, malformed timestamp, stale heartbeat | Not eligible for capability lookup/setup availability, even before periodic pruning. |
| runtime tombstone | Removed from the compatibility view and candidate lookup. |
| environment key configured | Configuration signal only; not live cloud authentication. |

Current read-time defaults are 75 seconds for heartbeat age, five minutes for
runtime evidence and scanner-only node updates, and at most 30 seconds of future
clock skew. An explicit runtime expiry is also enforced. Time synchronization is
required. The compatibility `ollamaModels` field still exists for old consumers;
new canonical setup uses explicit model/endpoint pairs.

Natural-language requests about devices, models and missing capabilities use this
inventory. Optional setup must first check already installed software, actual
OS/architecture, free RAM/VRAM/storage, supported installation methods and risk.
The read-only suggestion no longer invents a Jetson/Pi target or installation
command. A proposal is not a compatibility guarantee. The existing setup planner
and research tools remain responsible for a concrete, approved plan and checks.

## Known SSH hosts are private metadata, not permission

The optional `.nova-data/hosts.json` is local runtime data and excluded from Git
and the source package. A fresh checkout has no real or automatically seeded
example host. Host presence does not grant ownership, admin access, or consent;
execution still requires request-scoped policy and tool gates.
Both `/hosts` and `/host` management aliases require Owner/Admin. An automatic
address correction cannot redirect a host with a credential reference; use an
explicit owner host-management action. Rejected persistence is not published as
a completed host-address correction in memory.

Use SSH keys/agent where possible. For password-based unattended access, provision
a node-local `XAVENTRA_SSH_<NAME>` environment variable through your service's
secret management and store only its reference:

```text
/hosts new worker 192.0.2.10 operator env:XAVENTRA_SSH_WORKER
```

The example address is documentation-only. Never paste the secret value into
chat. References are not credentials and are not automatically copied to other
nodes. Resolution occurs locally at SSH lookup/execution; a missing reference
fails explicitly. An explicit connection password is no longer auto-persisted in
the host database. To override an unavailable reference deliberately, select
SSH-key authentication explicitly rather than relying on silent fallback. This is
not a claim that all SSH subprocess/logging paths have
been audited or that environment storage is an OS-backed credential vault.

### Existing plaintext files and recovery

Legacy password files remain readable for reconnect compatibility, but metadata
writers refuse to overwrite them. This prevents silent password loss or another
plaintext write. It does **not** encrypt or remove old passwords. Prepare a
private backup, configure and verify a key or node-local reference, then explicitly
migrate each record by removing the password field and retaining its host metadata.
Do not publish the backup. Re-run a read-only connection check before resuming
automation. No migration or production change is performed by this source update.

Malformed databases also fail closed on write. Restore a known-good private file
or repair it locally; errors must not overwrite it with an empty database. Keep
private directories protected by native filesystem permissions/ACLs on every OS.

## Verification and remaining gates

`npm run build && npm run check:capabilities` exercises actual compiled graph,
setup and host-storage APIs with synthetic input plus process restart. It performs
no network requests, SSH connection or installation. Three-OS CI preserves reports
including failures. See [2.78.9 verification](VERIFICATION_2.78.9.md).

Still open: complete live multi-node discovery/reconciliation and user-scoped
provider auth acceptance, resource-qualified install recipes, independent install
and rollback checks, explicit legacy credential migration, and the broader SSH
execution/auto-provisioning risk matrix. This checkpoint is not an RC or a claim
to discover every possible installed AI application.
# Non-AI service exclusions and retry policy (2.78.24)

The built-in scanner tries known AI protocols on their usual ports. A web shop
or another application can legitimately use one of these ports. A failed probe
is not a bind conflict and does not authorize stopping or moving that service.

For a known non-AI service, configure **only the scanning node's** environment:

```dotenv
XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS=http://127.0.0.1:8020,http://192.0.2.20:8080
```

Use comma-separated plain HTTP origins, without credentials, paths, queries or
wildcards. `localhost`, `127.0.0.1` and `[::1]` are equivalent for exclusions.
Other hosts are not excluded by port alone. Apply changed environment through
the approved restart/update workflow; preserve it in the node's deployment
definition. Neither periodic full scans nor `forceFresh` bypass exclusions.
Removing an exclusion permits discovery again, subject to any existing backoff.
This affects the built-in AI scanner, not explicitly configured model requests,
provider plugins or Docker healthchecks.

Unreachable endpoints and HTTP 429/5xx use exponential retries from one minute
up to fifteen minutes. Other non-2xx responses and protocol mismatches start at
thirty minutes, with a six-hour ceiling. Those are minimum retry times: the next
scan runs on its normal schedule. Successful probes clear their failure state.
An HTTP failure is scoped to the origin/path; a body mismatch is additionally
scoped to the service so another protocol can still match the shared endpoint.

The node-local `.nova-data/ai-probe-backoff.json` holds at most 512 retry records,
with failure counts, reasons and deadlines, never HTTP bodies or credentials.
It is advisory state, not canonical Memory or Mesh evidence. Restart preserves
backoff. Missing/corrupt cache falls back to discovery; invalid exclusion syntax
fails probes closed rather than silently ignoring the operator policy.
For intentional retry reset, stop the node and back up this cache before removing
only that file. A read-only cache still gives in-process backoff but cannot
preserve it after restart. No automatic deletion of user data is performed.

Probe bodies are limited to 256 KiB; the three-second default deadline includes
reading the body. Redirects are not followed. Responses are untrusted protocol
data, never instructions. The static probe catalog is not proof that all AI
software is discovered or that models can execute tools.
