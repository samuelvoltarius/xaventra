# Signed container updates

This path downloads public GitHub releases and replaces **explicitly enrolled
Linux Docker runtimes**. It does not mutate a running checkout, run downloaded
shell scripts, or give the application access to Docker. Native distribution and
full RC certification remain separate.

## User flow

1. `/update check` discovers a newer eligible release and verifies its publisher.
2. `/update prepare <exact-release-id>` downloads and verifies, without activation.
3. The independent operator approves that release, baseline, target and Main epoch.
4. `/update deploy <exact-release-id>` submits a detached controller job. Accepted
   and running explicitly do **not** mean installed.
5. `/update status <exact-release-id>` reads signed status after the old process
   stops. Installed requires acceptance; rolled-back requires restored behaviour.

First adoption requires an operator-installed controller and updater **2.78.22+**.
Older download-only installations cannot safely bootstrap a privileged service
from an untrusted package. Later releases use the enrolled path without per-node
SSH build copies. A lost acknowledgement is not proof that no activation started.

## Automatic publisher enrollment

The `update-release.yml` workflow re-reads successful CI for a push to the **current
main**, exact SHA and synchronized Core/Desktop version. It rejects PR/fork input,
serializes publication and never overwrites existing tags/releases/assets.

- Create the protected GitHub environment `update-publisher`, restricted to main
  with the desired reviewer rules.
- Install a dedicated Ed25519 private key as environment secret
  `XAVENTRA_UPDATE_PUBLISHER_KEY`; set its nonsecret ID in environment variable
  `XAVENTRA_UPDATE_PUBLISHER_ID`. Keep a vault copy. Build jobs never see this key.
- Enroll only its public key on clients/controllers, independently of downloads.
- Enable repository variable `XAVENTRA_UPDATE_PUBLISHING=enabled` after enrollment.
- The GHCR container package `samuelvoltarius/xaventra` must permit anonymous reads.
  A private package is an external configuration blocker, not a reason to copy
  user OAuth credentials to the updater.

Native amd64/arm64 jobs build the same source with locked dependencies and a pinned
base. Both jobs test the actual image's daemon start, authenticated REST and CLI
stop with isolated state and a loopback provider before the signing job runs.
The signing job runs only the small publisher script, with no npm/application
initialization. It publishes `xaventra-update.json`, two platform `.tar.gz` packages
and `SHA256SUMS`. Each archive has one `container.json` descriptor binding a canonical
GHCR **digest**, source SHA, version and architecture. The controller parses without
extracting paths, verifies its own download and checks the pulled image identity.

The workflow creates a draft, uploads all assets, verifies sizes, then publishes.
A failure retains the draft. This does not certify open RC gates or publish native
desktop executables. Existing tags without a matching release need inspection.
Until full release gates are closed, this publisher emits **prerelease/preview**
packages. Clients/controllers must explicitly opt into `channel: "rc"` to test
them. Default stable clients ignore previews; this is not a stable/RC promotion.

The initial public publisher identity is `xaventra-update-20260910`, distributed in
`deploy/update/publisher-20260910.pub`. SHA-256 of its SPKI DER encoding:
`12c9322618387537b605f9241619a87e48c8cc9f0df6a7bdc5f44438f2af887a`.
Only this public verification material is part of the repository. Enroll it through
the operator trust workflow, never by accepting a key offered by a downloaded package.

## Host controller and authority

Install `scripts/update-controller.mjs` plus compiled `dist/` outside application
release trees, root-owned with no runtime-writable ancestors. Run using a separate
supervisor. Keep publisher, approval, receipt and authority identities distinct.
The app gets a client token and public receipt key, no signing key or Docker socket.

Root-private controller JSON fields:

| Fields | Purpose |
| --- | --- |
| `targetId`, `stateRoot`, `grantsRoot` | Exact node, durable private journals, exact-release grants |
| `socketPath` or `port`, `clientTokenFile` | Dedicated Unix socket (preferred), or loopback behind HTTPS; authentication |
| `receiptPrivateKeyFile`, `approvalPublicKeyFile` | Independent signing and approval verification |
| `publisherPublicKeyFiles` | Publisher ID to enrolled public-key file map |
| `authorityUrl`, `authorityPublicKeyFile` | Independent current Main lease/fencing authority |
| `drainUrl`, `drainOperatorPrivateKeyFile`, `drainAuthorityPublicKeyFile` | Independent action-admission barrier |
| `dockerSocket`, `deploymentFile`, `templateFile`, `stateHelperImageId` | Engine, enrolled baseline, confined template and trusted helper digest |
| `probes` | Independent id/target/URL/status/body-SHA acceptance predicates |
| `writerHosts`, `requiredWriterHosts`, `externalWriterSinks`, `sinkFenceProfiles` | Complete enrolled writer inventory and signed sink-fence proofs |
| `stateAuthorityUrl` | Alternative independently owned full writer/state barrier |

The deployment has `targetId`, `initialReleaseId`, `releases`. Each release has
`version`, full `containerId`, `configHash` from `dockerRepairConfigHash(inspect)`,
and `release` with id, previousReleaseId, sourceHash, immutable imageId and binding.
Independently establish the first source hash; do not invent it from a version.
Subsequent candidate registrations and current identity persist in controller state.

The Engine create template requires numeric non-root UID/GID, read-only root,
all capabilities dropped, no-new-privileges, resource/log limits, health check and
restart policy **no** (one restart owner). Persistent data must use named volumes.
Candidate volumes are fresh. Read-only bindings use explicit `Mounts`. Host-network,
writable host binds, privileged devices, Docker sockets and shared original/candidate
writable volumes are rejected. Existing nonconforming runtimes need a deliberate
backup/migration/enrollment operation; they are not automatically adopted.

Mount only a dedicated root-owned, group-traversable socket directory read-only
into the app. Runtime `XAVENTRA_UPDATE_CLIENT_FILE` points to its local JSON:

```json
{
  "socketPath": "/run/xaventra-update/controller.sock",
  "targetId": "example-node",
  "tokenFile": "/run/secrets/update-client-token",
  "receiptPublicKey": "<operator-enrolled public PEM>"
}
```

The app receives a separately permissioned token copy; the server copy remains
root-private. Do not blindly unlink an existing socket on restart. HTTPS is an
alternative to the Unix socket, not permission to expose the Engine remotely.
Enroll `updateReceiptPublicKeyFile` in the existing drain service: normal updates
use `release-update`, not fabricated Doctor fault-to-healthy receipts.

## Approval and recovery

Run the independent operator tool:

```text
node scripts/approve-container-update.mjs <operator-config> <exact-release-id>
```

Its root-private config has `controllerConfigFile`, `authorityGrantsRoot`,
`approvalPrivateKeyFile`, `holderNodeId`, `leaseEpoch`, `probeId`. It independently
downloads/verifies and creates a nine-minute exact grant. The live authority checks
the holder/epoch; the tool never acquires or renews a lease. Existing grants are
retained, not overwritten during an uncertain attempt.

The controller closes admission and verifies complete quiescence. The writer barrier
inventories **all** containers and refuses unknown state sharers instead of stopping
them. External sinks require fresh signed write fences. An empty task queue or a
boolean configuration flag is not proof. Shared-state peers need independently
prepared migration before reopening; unsafe peer resumes remain blocked.

Stop precedes snapshot. SIGKILL/OOM is not an acceptable snapshot point. The trusted
helper clones named-volume contents/modes, verifies hashes and unchanged originals,
and rejects links/special files/nonempty destinations. Original container and data
remain the rollback backup. Updates do not auto-delete backups.

Only candidate health, exact identity, independent acceptance and current authority
allow installation. Configure the independent probe to cover version, persisted data
and minimal chat/tool acceptance, not just a listening port. Failure stops the
candidate and restarts the untouched baseline; its acceptance fingerprint must match.
Admission reopens only after this evidence.

Update journals fsync before swaps. Interrupted jobs and lost authority retain locks,
registrations and exact IDs. An operator must reconcile real Engine state and authority
before further work: never delete locks because a timeout elapsed or start an SSH
rollout in parallel. Diagnostics remain private. A blocked attempt does not claim
automatic crash recovery or successful installation.

`scripts/check-container-update.mjs` uses real Linux Docker, compiled slash handling,
HTTP release fixtures and a pinned `XAVENTRA_REPAIR_SANDBOX_IMAGE`. Fixture issuer,
drain and local image are **not** live GitHub/GHCR or production enrollment evidence.
