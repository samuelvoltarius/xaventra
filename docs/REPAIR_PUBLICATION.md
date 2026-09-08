# Automatic repair publication and writer coverage

Introduced in 2.78.18. This is an opt-in operator subsystem, not permission for a
model to build arbitrary images or acquire root. Production activation remains
disabled until the installation's writer inventory and authorities are enrolled
and independently accepted.

## Publication contract

1. Enroll the current release's **clean tracked source** in a protected store.
   New Git snapshots exclude old refs, runtime configuration, environment files,
   memories and model weights.
2. Approve an exact patch, baseline/candidate hashes and an operator-installed
   original-failure test/HTTP predicate. Candidates cannot replace their oracle.
3. A separate publisher repeats isolated baseline, candidate, rollback and
   recovery checks. A fixed compiler runs non-root, read-only, without network,
   credentials, host directories or a Docker socket inside its container.
4. Trusted packaging copies compiler output and dashboard assets as data, never
   running candidate npm scripts or Dockerfiles. Dependency-image identity,
   lock integrity, image ancestry and output hashes are checked.
5. Sign the artifact and create a **stopped** candidate with fresh writable
   volumes. The deployment driver checks its full configuration/confinement.
6. Drain tools and enrolled background writers, clone state, activate and retest
   the original HTTP failure independently. Only a signed recovery receipt
   advances `current.json` to the candidate source. Rollback keeps the baseline;
   old receipt replay never moves a later source index back.

Core candidates deterministically increment all four Core/Desktop manifests and
locks and add a repair changelog. These changes participate in approval hashes.
Dependency hashing omits only application-version fields, never dependency
versions or integrities. Prerelease versions require explicit policy.
This creates a **local signed repair artifact**, not a GitHub release or signed
native Desktop installer. Those distribution gates remain separate.

## Protected operator entrypoints

Install controller/publisher code and compiled imports outside runtime mounts,
root-owned and non-writable by candidate UIDs. Preserve existing approval,
release-signing, receipt and authority identities; never overwrite them.
Root-only production JSON configuration is intentionally not included here.

`node scripts/repair-publisher.mjs <protected-config> enroll` enrolls once.
`publish <protected-request>` accepts signed approval plus exact patch;
`commit-source <protected-receipt>` accepts an independent recovery receipt.
The controller invokes these fixed operations when `publisherConfigFile` is
configured. It never accepts commands, templates or key paths from the model.

Publisher fields: `root`, `stagingRoot`, `imageId`, `initialSourceRoot`,
`initialReleaseId`, `signingPrivateKeyFile`, `signingPublicKeyFile`,
`receiptPublicKeyFile`, `approvalPublicKeyFile`, `candidateTemplateFile`,
`dockerSocket`, and explicit repair `profiles`. Prepare the dependency image
with `node scripts/build-repair-sandbox.mjs` after building trusted operator code.

The daemon's `XAVENTRA_REPAIR_SOURCE_STORE` is a **read-only view** of source
mirrors and index, not the private signing/configuration directory. Ensure the
runtime UID can read that view without exposing keys. Source is resolved again
for each repair; no write access to the root-owned store is required.

## Writer coverage

`writerHosts` supplies pinned Engine transports, exact container IDs/config
hashes and protected mount sources. `requiredWriterHosts` must match completely.
Checks list **all** containers, including unlabeled/stopped ones. Unknown writable
volume sharers deny activation before any stop. Only enrolled containers may be
stopped; staged candidates must remain stopped. Restart ownership must be `no`;
the controller never silently overrides Docker, systemd or another supervisor.

Independent tool drain is mandatory. Process shutdown covers background work
inside enrolled containers, but does not prove detached remote actions ended.
Each `externalWriterSinks` entry needs a `sinkFenceProfiles` adapter proving a
fresh challenge, ticket binding and **sink-enforced** write fence. An HTTP promise
that callers intend to stop is not database fencing. Missing adapters fail closed;
no generic PostgreSQL/API enforcement implementation is claimed.

Old main state remains rollback evidence. Peers with independent storage can
resume after the signed receipt. A peer sharing old rollback storage cannot:
it needs an explicitly verified replacement/state-migration workflow, still open.
Root/Engine administrators, non-container host processes, extra storage plugins
and unlisted remote sinks remain operator inventory/trust prerequisites. A mount
scan cannot discover every possible external writer.

`health_status` is not silently classified as a pure bounded read: its warning
callback can dispatch work. Unclassified tools need independent reconciliation;
do not mark all tools settled merely to make maintenance pass.

## Recovery and acceptance

Publication and container creation have separate persistent locks. Ambiguous
build/create/stop operations retain evidence and block implicit replay. Inspect
the exact owned operation before reconciliation; never remove locks or restart
all containers as a shortcut. The source index uses compare-and-swap, not
distributed consensus or claimed power-loss durability on every storage backend.
Successful source/writer/drain completion is durably acknowledged by receipt
hash. Concurrent status queries share one completion; after controller restart a
completed receipt cannot reopen old writers. Incomplete attempts use only their
own saved writer inventory, never the most recent transaction's barrier.

`node scripts/check-repair-publication.mjs` tests actual isolated compilation,
image creation, background-writer shutdown, state cloning and independent HTTP
recovery/source advancement. Lease, admission and original fault are controlled
fixtures, not production HA or a general model benchmark. Reports preserve SHA,
dirty status and case-level failures in `.nova-data/repair-publication-qa/`.
Production adoption, remote sink enforcement, all-node coverage and shared-state
peer migration remain separate gates.
