# Docker self-repair: operation and evidence

Version 2.78.16 extends the existing Doctor and external activation controller.
It does not give the candidate a Docker socket, shell deployment command,
signing key or authority to approve its own work.

## What is implemented

The normal native Doctor worker reads current diagnostic evidence and, only
for a registered source profile, the exact source and immutable reproduction
through `read_file`. Other paths, links, secrets and source changes during
generation fail closed. Candidate JSON enters the existing actual isolated
sandbox. A proposal remains unexecuted until the owner approves its exact ID.

The external `DockerRepairDriver` implements the existing deployment interface:
prepare -> original fault -> activate -> independent original predicate ->
resolved receipt, or scoped rollback and restoration. It uses the local Engine
API v1.45 (Docker 26+), full container IDs and image config digests, never names,
tags, `compose down`, broad restarts, pulls or production-host builds. It retains
the original stopped container. Only an externally verified receipt closes the
Doctor case. See [Engine API contract](https://docs.docker.com/reference/api/engine/version/v1.45/).

The prepared containers require numeric non-root UID/GID, read-only roots,
dropped capabilities, no-new-privileges, memory/CPU/PID/log limits, a readiness
check and restart policy `no`. Host namespaces, devices, shared-container
networking, writable bind mounts and Docker sockets are refused. A change in
the approved inspect configuration rejects activation. The observed Engine 29
`OomKillDisable: false -> null` normalization is handled explicitly; `true`
remains denied. Older DSM kernels lacking these limits are not silently exempt.

## Protected controller and distinct identities

Install the trusted controller outside every candidate mount. As an explicit
administrator operation, provision a **new**, protected directory:

```sh
node scripts/provision-repair-identities.mjs /opt/xaventra-repair-new
```

It creates separate approval, receipt, release and authority keys, prints only
public fingerprints and refuses existing directories. No services start and no
grant is issued. Keep private files 0600, directories 0700, root-owned with
nonwritable ancestors. Only the approval identity belongs in the approving
runtime's local secret store; receipt/release/authority private keys must never
be accessible there, including through read-only mounts. No key enters Mesh,
Memory, Git or the model prompt. Existing deployments need an audited secret
installation step, not copied private configuration from another node.

Start `scripts/repair-controller.mjs` with protected private configuration as
in [the activation guide](REPAIR_ACTIVATION.md), plus:

- `driver: "docker"`, `dockerSocket`, `dockerDeploymentFile`, `stateFile`.
- The signed deployment envelope contains `targetId`, `initialReleaseId`,
  `catalog` (candidateHash -> releaseId) and `releases`.
- Each release entry is `{containerId, configHash, release}`. `configHash` is
  produced by `dockerRepairConfigHash` from actual inspect output. The signed
  release contains `{id, previousReleaseId, sourceHash, imageId, binding}`;
  binding is the exact approved proposal/source/probe/target tuple.
- All release images/containers are prepared by the trusted release pipeline
  before activation. The adapter does not blindly sign runtime-provided images
  or generate deployment configuration from a model's command string.

`scripts/repair-authority.mjs` is a separate protected service. Its configuration
specifies `port`, `grantsRoot`, `authorityPrivateKeyFile`, `coordinatorRestUrl`
(HTTPS), and `coordinatorKeyFile`. It reads the existing `nova-main` lease; it
never acquires, overwrites or renews one. An absent/unreachable/expired lease or
wrong holder/epoch denies permission. Both services bind loopback; remote
access needs the operator's authenticated HTTPS gateway.

A private grant file `<patchHash>.json` contains `binding`, `expiresAt`,
`holderNodeId` and `leaseEpoch`. It must be created through the operator's
approval process and expires within ten minutes. A matching node identity alone
is not permission. The controller sends the complete ticket; the signed reply
binds its hash and a fresh challenge. Legacy partial-tuple authority replies are
no longer accepted. No default allow-all authority or automatically issued grant.
The signed decision cannot outlive its grant, ticket, lease or applicable drain
attestation, even during network delay.

## Persistent state and recovery

Original and candidate containers cannot share writable storage. For stateful
use, prepare separate empty named volumes owned by the same runtime UID, mapped
to the same container destinations. Configure `stateHelperImageId` with a trusted
immutable Node helper image and `stateAuthorityUrl` (the authority's `/state`).

After verifying old-runtime exit, the bounded no-network/non-root helper mounts
only the original volume read-only and the candidate volume writable. It copies
and compares all supported contents/modes and rechecks the original. It rejects
links, special files, hard links, nonempty destinations and exceeded budgets.
It never follows application paths onto the host. Partial candidate state is
retained for diagnosis, not silently reused. The original is not modified.

Local copying is **not** distributed quiescence. The deployment's writer-fencing
owner must continuously attest that in-flight tasks and shared/external writers
are drained or fenced. `/state` requires fresh, ticket-bound `quiescence` evidence:
`{bindingHash, verifiedAt, expiresAt, externalWritersQuiesced:true}`. Evidence older
than 15 seconds is refused. Creating this field by assumption or observing an
empty queue is not valid production acceptance. This source does not implement
a generic global Mesh/database/API drain. Lease expiry during replacement
blocks further writes, including unsafe rollback; preserve the controller lock
and reconcile exact containers and authority. Never delete a stale lock blindly.

Since 2.78.17 `/state` additionally requires the independently signed
[tool-admission drain](REPAIR_DRAIN.md); a root grant alone is insufficient.
Configure the authority's read-only drain observer and controller's separate
operator client. This is a deliberate fail-closed tightening of stateful repair.

To adopt an existing deployment, first verify backups/restore, exact image and
configuration, stop other update/restart owners, provide real writer fencing,
prepared artifacts and source continuity, and use the original failing operation
as the oracle. Do not replace a Docker deployment with the standalone process
driver, share rollback volumes, or substitute generic `/health` for the symptom.

## Reproducible acceptance (not production)

Prepare the dependency image with `scripts/build-repair-sandbox.mjs`, then set
its printed `XAVENTRA_REPAIR_SANDBOX_IMAGE` in the isolated test environment.

```sh
node scripts/check-docker-repair.mjs
node scripts/check-docker-repair-state.mjs
```

The first runs the native Doctor/Kernel, original assertion, four sandbox phases,
proposal and owner gate, signed external controller, actual disposable containers,
HTTP recovery, case reconciliation, duplicate refusal and a wrong-candidate
rollback. The separate real signed HTTP authority is included; the coordinator
lease and operator grants in this disposable test are explicitly **fixtures**.
Default model answers are **scripted**. To separately test real model
decisions, supply an explicitly authorized `XAVENTRA_RESEARCH_QA_URL` and model;
the same checks run without hard-coded model patches. Test signing/authority
identities are disposable and must never become production identities.

The second checks real state-copy contents/modes, preservation of original data
after candidate writes, nonempty/linked-state rejection and missing-quiescence
denial. Its quiescence authority is a fixture, not a live Mesh proof.

Reports under `.nova-data/docker-repair-qa/` and `docker-repair-state-qa/` contain
source SHA, dirty status, evidence class, case-level failures and IDs. Preserve
negatives. Initial live failures exposed missing source-read evidence, Docker
local-digest build semantics and Engine inspect normalization; these are not
erased when later tests pass. A bounded successful model repair is not evidence
that arbitrary unknown errors, all modules or the whole product are RC-ready.
