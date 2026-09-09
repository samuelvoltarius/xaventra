# Authenticated host access

Xaventra's application container does not receive `docker.sock`. A separate,
operator-installed agent owns Docker access and exposes only typed local calls.
This feature is opt-in. Upgrading Core alone does not provision host credentials,
enroll Docker targets, change container mounts or give the application host root.

## What is supported

- `docker_ps`: live container inventory, including full IDs and state.
- `docker_status`: selected container state/health, not raw inspect/Env.
- `docker_logs`: 1–200 lines by exact ID, bounded output and secret redaction.
- `docker_control`: start, stop or restart an operator-allowlisted full ID,
  with independent Ed25519 approval and observed final state.
- `/docker list`, `/docker all`, or an unambiguous request such as
  “Sag mir welche Docker Container local laufen”: Owner/Admin inventory through
  the existing registry, admission, Execution Kernel, validator, Outcome Ledger
  and telemetry. No model inference or arbitrary successful secondary tool can
  stand in for the requested Docker inventory.

There is no exec, shell, pull, create, remove, mount, environment modification or
generic Docker API proxy. Container lifecycle success means observed process
state, not application health, successful deployment or restored user data.
Updates and self-repair must still use their existing signed rollout/drain gates.

## Operator installation (Linux)

Run the compiled `dist/host/agent-main.js` separately from the application, with
Node 22 and Docker socket access. Protect the installation/configuration from
the application UID. Do not run code from an app-writable working tree as root.
Use a dedicated socket-sharing group; it must **not** be the Docker group.

Operator configuration, outside application mounts:

```json
{
  "nodeId": "example-node",
  "clientId": "example-node-runtime",
  "socketPath": "/run/xaventra-host/agent.sock",
  "dockerSocket": "/var/run/docker.sock",
  "tokenFile": "/etc/xaventra-host/client-token",
  "stateDir": "/var/lib/xaventra-host/receipts",
  "allowedContainerIds": []
}
```

The operator generates a random token of at least 32 bytes, writes it privately
to `tokenFile`, and configures root ownership and a read-only group grant for the
application. Never put the token itself in prompts, examples, Memory, Supabase,
Mesh capabilities or command-line arguments. The example intentionally enables
no writes. Only explicit operator enrollment may add full immutable container IDs.

Start the service with:

```sh
node /opt/xaventra-host/dist/host/agent-main.js /etc/xaventra-host/config.json
```

The service creates a local socket with mode `0660`. Have the supervisor create
its containing directory and set the dedicated group on both directory and
service process. An existing socket is never removed automatically: investigate
a stale or competing instance before operator removal. Keep a single service
owner; this protocol is not a distributed leadership election.

Application-side environment (file paths only):

```text
XAVENTRA_HOST_AGENT_SOCKET=/run/xaventra-host/agent.sock
XAVENTRA_HOST_AGENT_TOKEN_FILE=/run/secrets/xaventra-host-token
```

Mount the socket directory and the single token file read-only into the app,
and add only the dedicated socket-sharing group. Do not mount the raw Docker
socket, receipt directory, host root, approval private key or operator config.
Preserve the app's read-only root, dropped capabilities, no-new-privileges and
resource limits. Inventory can reveal service names: treat the token as sensitive.
Logs can contain secrets in arbitrary formats; redaction is defensive filtering,
not a guarantee that every possible secret representation can be recognized.

## Signed lifecycle approval

For writes, configure `approvalPublicKeyFile` with an independent Ed25519 public
key. Keep its private key exclusively with the human/operator approval service,
not with the host agent or application. Set `allowedContainerIds` explicitly.

The signed permit contains exactly:

```text
id, nodeId, clientId, containerId, action, expiresAt, approvedBy
```

- `id`: unique 16–80-character alphanumeric/hyphen operation ID.
- `containerId`: exact 64-character Docker ID, never a name or prefix.
- `action`: `start`, `stop` or `restart`.
- `expiresAt`: epoch milliseconds, at most five minutes in the future.
- `approvedBy`: trusted current `channel:authorizationUserId`; the Core tool
  checks Owner/Admin and matches this identity against the signed permit.
- `nodeId` and `clientId`: match the operator-configured service identities.

Use `permitBytes` from `dist/host/docker-agent.js` and Node's Ed25519
`sign(null, permitBytes(permit), operatorPrivateKey)`; encode the signature as
base64. A model-written “approved” field is not authority. The agent has no
signing endpoint. Existing PATCH_GATE/tool policy may narrow or deny a call even
when its host permit is valid; this adapter never overrides those decisions.

The agent persists/fsyncs an intent before mutation. Replaying the same completed
permit returns its historical receipt, not a new observation or second action.
After a crash/timeout with only an intent, it refuses another attempt: independently
inspect Docker state and reconcile as operator. Never delete uncertain records to
force a retry. Do not enroll Core/Main containers for ad-hoc lifecycle changes
that bypass release fencing, backup or active-task drains.

## Verification and recovery

```sh
npm run build
XAVENTRA_HOST_TEST_IMAGE=<already-present-node-image> node scripts/check-host-agent.mjs
```

The acceptance creates its own confined container, tests authenticated inventory,
logs, signed stop/start/restart and replay after agent restart, then removes only
that exact fixture. It does not modify existing containers. CI runs this against
its independently prepared sandbox image. Unit HTTP/fake-Engine tests are a
separate evidence class from the real Docker run.

If the agent is absent, the user gets an explicit host-access-unavailable error.
Do not fall back to free shell execution or install Docker packages in the app.
Disconnecting its socket/token mounts removes application access; retained
operator receipts and previous deployment backups remain available for recovery.

Windows named-pipe and DSM/macOS packaging/enrollment require their own live
acceptance. Linux acceptance is not proof that every host platform is ready.
General host files/services, remote enrollment, GUI permit issuance, automatic
Mesh credential provisioning and production HA write authority remain separate
work; this is the bounded Docker adapter, not unrestricted administration.
