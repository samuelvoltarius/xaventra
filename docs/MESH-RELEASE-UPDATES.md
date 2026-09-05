# Signed Mesh Release Updates

Nova Main is the release authority. Worker nodes never run an unrestricted
`git pull`, arbitrary shell payload, `killall node`, or an unverified binary.

## Release flow

1. Main detects a new `package.json` version or the owner runs `/update deploy`.
2. Main runs typecheck, all tests, build, and the build-freshness check.
3. Every file in `dist/` is hashed into a deterministic tree manifest.
4. Main signs the manifest with its existing Ed25519 mesh identity.
5. Each worker receives the staged release over authenticated SSH.
6. The worker verifies the signature against its configured Main public key
   and verifies every staged file hash before activation.
7. Nova activates one canary at a time using a typed `systemd` or
   `docker-compose` profile.
8. Success requires both the release marker in the running runtime and either
   a fresh active Mesh Registry heartbeat or a fresh signed Direct Mesh peer
   heartbeat observed and persisted by Main.
9. A failed runtime or heartbeat check restores the previous `dist/` and, for
   Docker, the previous image.
10. The Outcome Ledger and Trust view retain the release ID, artifact hash and
    node receipts. A model-written success message is not rollout evidence.

## Commands

- `/update status` shows the release ID and rollout receipts.
- `/update deploy` publishes the current tested build to all configured nodes.
- `/nodes sync <node>` publishes only to one configured node.
- `/nodes restart <node>` restarts only the configured Nova service/container
  and verifies a fresh heartbeat.

`mesh.update.autoDeployOnVersionChange=true` may make a semantic version change
the release signal, but only the fenced Main may execute it. A failed automatic
rollout is not retried in a notification loop; it waits for a controlled retry
of the same immutable artifact.

## Node profiles

Profiles live under `mesh.update.nodes` in `nova.config.json`. Only explicit
`systemd` and `docker-compose` profiles are accepted. Paths, hostnames, users,
service names, ports, and image names are validated before any SSH operation.
For an unprivileged SSH deployment user, a `systemd` profile may explicitly set
`useSudo: true`; the remote account must then have non-interactive sudo rights
for the configured service lifecycle commands.

Offline workers remain on their last verified version. They are updated on the
next controlled rollout after returning; Nova does not guess or bypass trust
checks to force an offline update.

## Current production profiles

- Spark: Docker canary, strongest eligible Main and vLLM compute node.
- NAS: hardened Docker HA standby. Preserve its node-local Mesh identity,
  Telegram secret and persistent state volumes.
- ns1/ns2: constrained Docker workers with channels disabled and
  `NOVA_MAIN_ELIGIBLE=false`.
- Pi 5: retained disabled rollback runtime after NAS migration. An ordinary
  release may stage verified files there but must not enable the service; a
  staged runtime is not an active receipt.

Every active target must receive the identical signed tree. Rebuilding a Docker
image independently on each host invalidates that guarantee.
