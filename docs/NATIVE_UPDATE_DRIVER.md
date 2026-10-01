# Native update driver integration status

`NativeUpdateDriver` implements the existing `RepairDeploymentDriver` interface
for `UpdateActivationController`. It does not introduce another update lifecycle.
Only protected enrollment supplies release IDs, immutable program hashes,
package hashes, state IDs and exact approval bindings; caller preparation is not
used to choose paths or commands.

Before selection/start it requires current authority, writer quiescence, clean
process exit, a ticket-bound source/copy/source hash match, and a read-only
preserved baseline. Rollback requires independent baseline integrity evidence.
Durable switch intent names both releases before stop. Ambiguous operation
results remain under the shared controller's retained lock, never automatic retry.

## Not yet deployable

As of 2026-09-29, these components are part of the 2.78.57 source candidate,
not an enrolled production updater. Keep the following evidence levels separate:

| Evidence | Proven scope | Not proven |
|---|---|---|
| Component regressions and disposable Linux fixtures | Signed controller receipts, process/unit selection, archive checks and isolated state-copy/rollback behavior | Production authority, writer fencing or fleet rollout |
| Actual 2.78.57 Linux arm64 candidate payload | Clean source build, qualified archive and independent content/hash verification | Native x64 parity, signing or installation |
| Isolated daemon lifecycle on that payload | Boot, authenticated REST status, anonymous-access rejection and CLI stop; seven checks passed | Live-model chat, screenshot capture, Telegram delivery or production update/rollback |

The clean 2.78.57 candidate build at source
`56e43c06b45891aa81849b754aad6b3c6f148da2` contains 16 qualified ELF binaries.
Its 217,478,550-byte archive independently passes parsing and hash verification:
SHA256 `086bc1b7d36e96b1ec34acfc9a27ccfd7c7b44955fb0fe481eb91baf7208e583`.
The same actual payload passes all seven isolated daemon lifecycle checks above.
Runtime source, scripts and package manifests are unchanged at follow-up
`24b835b`; intervening changes affect generated documentation, test-fixture
path canonicalization and Desktop build dependencies, not that Core runtime. These results cover the complete
candidate build, but do not exercise screenshot capture or Telegram delivery.

Earlier dependency-only qualification of the published 2.78.56 baseline is
retained separately: 30,765 files, 16 ELF binaries, a 217,421,294-byte verified
archive and seven daemon lifecycle checks. That earlier payload excluded the
newer screenshot corrections; it is not substituted for the candidate result.
Neither run proves native x64 compatibility, signed native publication, safe
installation, production enrollment or full update/rollback. Those gates remain
required before activation. A healthy native daemon is not evidence that the
Docker update controller supports it.

## Build qualification and retained failures

The direct npm `chromium` dependency was the unused Tint/CEF Windows package,
not Playwright's browser. Source/browser/setup paths use `playwright`; no runtime
import of the Tint package exists. Its direct manifest/lock entry is removed and
the SBOM regenerated, without removing browser tools or weakening binary checks.
An isolated clean-source dependency-only correction build has zero foreign binary
failures and loads Playwright's Chromium API. This is not a browser-launch test.
The original 13-binary failure is retained. A subsequent package attempt exposed
an overly broad private-path prefix check that rejected public dependency
`.github`, `.gitkeep` and `.gitattributes` resources. The corrected classifier
allows only `.github`, `.gitkeep`, `.gitattributes`, `.gitignore` and `.gitmodules`
segments inside `node_modules`; other `.git*` entries, including `.git`,
`.git-credentials` and `.gitconfig`, remain rejected. Private environment,
runtime and key-file rejection is preserved. Requalification of the retained
baseline payload produced the earlier archive described above; the clean
2.78.57 candidate build subsequently passed too. Earlier failed reports remain
negative evidence, not rewritten successes. A path allowlist does not replace
secret scanning.

`scripts/stage-native-build.mjs` composes the build-stage tools on an architecture-
matching Linux host: exact clean revision/package version, fresh checkout without
ignored dist/dependency artifacts, credential-minimal npm/build environment,
separate production `npm ci --omit=dev --ignore-scripts`, explicit release assets,
declared bin conversion, mode normalization only in the new payload, bounded
inventory and qualified archive producer. Reports and failed stages are retained.
This recipe does not sign, publish, install or start a daemon. Use reviewed bundled
tooling and disposable source; build-script execution is not a sandbox boundary.

The tiny clean-repository fixture completes actual npm/build/package steps and
rejects wrong revision/stale artifacts. The first real published 2.78.56 arm64
build compiled and staged 527 production packages/30,867 files but FAILED
qualification: the `chromium` dependency carried 13 Windows PE binaries. That
original build has no approved archive. The corrected dependency-only build is
distinct; browser tools were retained and architecture checks were not relaxed.
`inspect-native-build-binaries.mjs` provides read-only inventory diagnostics.

`materializeNativeBin` supports disposable Linux build staging only. Explicit
`node_modules/**/.bin/name` links become regular0755 shell starters that execute
the original package target in place, preserving relative module imports and
arguments. The target must stay inside that dependency directory, be a regular
non-linked executable, and match the package's exact `bin` declaration. Traversal,
external targets, undeclared names and overwriting regular files reject. Other
symlinks still fail archive validation. This function must never run on installed
production dependencies; the caller must supply a fresh isolated build stage.
`check-native-bin-staging.mjs` proves real Linux relative-import/argument parity
before and after conversion, plus the negative boundaries. Full dependency-tree
staging and daemon acceptance remain separate gates.

Native build inventories may now explicitly approve `mode:0755` for executable
files (`0600`/`0644` remain allowed; default0644). On POSIX, source execute bits
must match this approval; privileged or group/world-writable source files reject.
The producer preserves the approved mode in the compressed archive, whose hash
is signed. The existing content-only tree hash does not bind permissions: a future
installer must preserve and verify modes from the verified archive separately.
`check-native-package-modes.mjs` reproduces EACCES from the old all0644 behavior,
then extracts a locally produced trusted fixture and executes its0755 entrypoint.
This generic-tar fixture is not an installer for downloaded releases. Both old
failed and corrected artifacts are retained; no production executable is run.

`buildQualifiedNativeArchive` gates the producer on exact Core package version,
ESM entrypoint and matching v3 lockfile root identity. It hashes approved input
bytes before inspecting binary headers and the producer rehashes during packing.
Native `.node`/shared-library files must be ELF64 little-endian for the requested
x64/arm64 machine; foreign ELF, PE and recognized Mach-O headers reject without
loading them. Byte/file/time bounds and non-linked paths apply. This is a header
and metadata check, not libc/ABI compatibility, dependency completeness, clean
source provenance or actual workload acceptance. A real arm64 addon header was
accepted for arm64 and rejected for x64 by the read-only fixture
`scripts/check-native-build-qualification.mjs`. It does not demonstrate that the
addon can load. The staging recipe and actual arm64 candidate payload/lifecycle
checks are described above; other-architecture and full update/rollback
acceptance remain required. No package is released solely on header qualification.

`scripts/publish-native-update.mjs` is the separate native signing entrypoint.
Bundle it from the reviewed signer revision before introducing credentials; never
execute scripts from downloaded payloads. Arguments are exact version, commit,
approved-plan path, independently supplied plan SHA256 and a new output directory.
The plan is `{schema:1,version,commit,builds:[{arch,archive,sha256,size,treeHash}]}`
with exactly one x64 and arm64 Linux build. Both archives pass the streaming
verifier before the existing Ed25519 publisher credential is used. Descriptor
signatures are checked back through the existing verifier. The separate final
`xaventra-native-update.json` and native descriptor names do not alter Docker's
manifest or target uniqueness. Archive files remain separate, hash-addressed by
the descriptors; callers must deliver those exact bytes too.

This is a locally verified entrypoint, NOT a configured protected CI job or a
published native release. The independently approved plan must come from clean,
architecture-verified builds with exact source/package version provenance and a
secret scan. The script binds those approvals; it cannot infer their truth from
caller-provided metadata. Existing native host enrollment must explicitly select
this manifest; Docker discovery must not be silently redirected. The acceptance
fixture's `--publisher <bundled-entrypoint>` option runs the actual signer in a
separate child, using ephemeral keys only, then independently verifies output.

`buildNativeArchive` is an offline build-stage producer, not a publisher or
installer. It takes an explicitly approved file/hash/size inventory; it never
discovers files from a runtime or executes package code. Only dist, dependencies
and package metadata paths are admitted; known runtime/config/key paths, links,
hardlinks, changed files and duplicate inventory entries fail closed. Source and
output must be separate. Exclusive output creation, bounded streaming and flush
precede independent archive-content verification. Failed output is retained and
does not produce a successful result. Metadata is normalized for deterministic
bytes. This path filter is not a secret scanner: isolated clean builds, approved
inventory provenance, secret scans and protected signing remain required.

`scripts/check-native-package-builder.mjs` builds real fixture archives and uses
fresh child processes for ephemeral signature/descriptor/archive acceptance,
tampering rejection and unchanged-original reacceptance. It runs on Windows and
Linux without production configuration or signing keys. This is not an actual
Xaventra payload build, a protected CI signing job or native installation proof.

`NativeReleaseEnrollment` loads a protected operator-owned enrollment file and
rejects any change to it during the adapter lifetime. It binds the exact ticket,
driver source/program/package identities, publisher key, manifest, canonical
descriptor record, archive and installed tree. The enrolled Node argv must execute
`dist/daemon.js` from that verified tree, not another script. Every verification
rereads evidence and bytes; successful results are not cached.
`createPublisherVerifiedNativeOperations` wires this verifier into the existing
operations adapter without accepting a caller-supplied publisher-success callback.
Rollback must retain the original verified script argument. Independent authority,
external fencing and runtime readiness still need real production implementations.
The low-level injectable adapter remains for component fixtures, not enrollment.

The Linux fixture now uses this protected enrollment and production-facing factory:
valid evidence passes, while modified code/archive, extra files, links and writable
code reject both selection and start before any systemd mutation. No fixture unit
is installed. This proves preactivation rejection, not publisher deployment,
archive extraction or successful actual-Xaventra activation. The protected native
publisher and actual installation/update/rollback acceptance remain open beyond
the separate candidate package and daemon lifecycle checks above.

`verifyNativeInstalledRelease` now verifies descriptor commitments against actual
archive bytes, streamed archive contents and two complete application file inventories. It reuses the existing
canonical tree hash through a side-effect-free module. Linux-root observation
requires root-owned runtime-nonwritable ancestors, directories and regular files;
links, hardlinks, special files and privilege bits are rejected. Traversal, byte,
depth and time budgets bound work; streaming reads compare file identity before
and after. No file is executed or extracted. Extra files change the signed digest.
The asynchronous archive verifier requires canonical native-v1 regular-file USTAR
inside gzip: root UID/GID, zero timestamp, modes 0600/0644/0755, canonical paths,
exactly two end blocks, no extensions, links, duplicates, file/directory conflicts
or trailing members. SHA256/size and the canonical file-content tree must agree
with the signed descriptor. Limits: 2 GiB compressed/payload, 100,000 inventory
entries, depth64 and60seconds. Decompression and file hashes are streamed.
This proves content equivalence, not safe extraction, permission equivalence,
currently loaded modules or defense against a malicious concurrent root operator.

The isolated Linux fixture `scripts/check-native-program-verifier.mjs` verifies
a valid signed file tree and rejects changed code, extra files, symbolic/hard
links, runtime-writable code, changed archive bytes and incorrect tree enrollment.
Its archive now contains real fixture files. A separately signed archive with
different contents rejects before both selection and start. It is not an actual
installable Xaventra build. The first streaming Linux run exposed a double-close
race; stream ownership now exclusively closes its descriptor and the failed run
is retained. An earlier
bundled run passed the checks but exited nonzero because importing the old tree
hash also activated a CLI guard; extracting the unchanged hash function into
`release-tree.ts` removed that side effect. Failed evidence is retained.
Protected enrollment and native operations now await the content verifier; no
production controller uses it yet. The producer and signing entrypoint exist
locally; a protected signing job and safe installation acceptance remain open.

`verifyNativeReleaseEvidence` reuses the upstream Ed25519 publisher verifier and
binds exact version/commit/architecture, descriptor bytes and enrolled tree hash.
The bounded single-entry package codec now has a distinct `native.json` variant
with archive SHA256/size, program tree commitment and fixed `dist/daemon.js`
entrypoint. Docker `container.json` and native descriptors reject each other;
native descriptors cannot supply shell commands or arbitrary entrypoints.
The existing protected publisher still emits Docker descriptors only. No native
release has been published by this change; current manifest target uniqueness is
unchanged. This API proves descriptor commitments, NOT an archive's bytes or the
installed application tree. Native `verifyRelease` must not return success from
this evidence alone. Archive/tree validation and enrollment binding are supplied
by the components above; protected native publisher integration remains open.

`scripts/check-native-release-evidence.mjs` is an opt-in disposable acceptance
fixture (`XAVENTRA_NATIVE_FIXTURE=1`, bundle first). Fresh real child processes
verify the serialized ephemeral publisher signature/descriptor, reject changed
bytes, then independently verify the original again. It retains public fixture
records only, not the private signing key. It installs or starts nothing.

Native enrollment can now name a distinct `rollbackStateId` and protected
rollback unit/profile. The logical release remains the original program; the
observed state must be the independently restored third state before and after
start. A rollback unit must use the enrolled original executable identity.
The driver rechecks baseline integrity after stop, validates ticket/state/hash
restoration proof, and rejects selection that still points to the original data.
Readiness receives the exact selected state ID. A restored runtime cannot silently
be reused as the original source of another update under the old enrollment.

With `XAVENTRA_NATIVE_ROLLBACK_FIXTURE=1`, the opt-in mount fixture drives actual
candidate start, intentional acceptance failure, restoration, protected rollback
unit selection, start and equal baseline/restoration acceptance through the shared
signed controller. An unprivileged service-owned ExecStartPost writes a witness
in the restored state. Original and failed-candidate data are preserved; replay
does not restart the service. The workload is still a disposable sleep service,
NOT Xaventra. Publisher/lease proofs are simulated; only ticket signing, local
systemd/process/storage operations and controller receipts are real. The default
negative mode remains: without writable rollback enrollment it must stay blocked.

`NativeRollbackState` now prepares a third independently enrolled writable state
from the original protected snapshot. It reuses the same bounded helper and
durable snapshot journal, binds the expected content hash to a freshly verified
original receipt, and requires clean stopped service observations before and
after restoration. It rejects overlap with either existing state, shared state
IDs/journals, missing original proof and changed replay data. Interrupted copy
retains intent/lock and is not automatically repeated. It never thaws, deletes,
selects or starts anything. Completed replay is allowed only before runtime
writes; changed runtime data must not be overwritten by replay.

The real private-namespace fixture now restores the baseline despite independent
candidate mutation, rehydrates the restoration receipt without recopy, writes to
the restored copy as an unprivileged child and verifies the original and candidate
remain unaffected. Running-service restoration and changed-copy replay are refused.
This component alone proves data preparation; the separate positive mode above
adds isolated rollback activation. Earlier deliberately blocked receipts are
retained and are not retroactively marked successful.

`EnrolledNativeUpdateOperations` connects the existing service, selection and
snapshot components under the shared activation controller. It clones and
cross-checks enrollment, resolves current identity from protected unit content,
requires fresh bound authority/quiescence, and persists direction-bound switch
intents without conflicting overwrite. Publisher/artifact verification and
maintenance/fencing remain explicit independent adapters, with no success defaults.
Starting also requires a separate `runtimeReady` proof: a preserved read-only
baseline alone is not a writable rollback runtime. This proof must not silently
thaw the backup or migrate storage. Restore-to-independent-writable-state
activation has isolated fixture coverage as described above; production
enrollment and actual Xaventra update/rollback acceptance remain open.

The isolated mount fixture now runs this composition through real signed tickets
and the shared controller: an actual unique systemd candidate reaches its probe;
intentional acceptance failure selects the baseline but blocks its start because
the writable rollback prerequisite is deliberately absent. Receipt replay does
not restart the service, and the original data remains unchanged. This is a
positive **fail-closed** check, not successful rollback acceptance. Publisher,
lease and candidate readiness callbacks are simulated in that disposable fixture;
the workload is sleep, not Xaventra. Production enrollment is still prohibited.

`NativeSnapshotAdapter` now composes the helper/store with real enrolled systemd
observation and independent authority/quiescence callbacks. New copies require
the expected baseline unit, clean stopped state and repeated observation around
external fencing checks. Baseline verification is a separate phase: it may run
while the candidate is active but never while the original is running. No
stop/start/remount happens implicitly in this adapter. The private-namespace
fixture uses a unique actual systemd service to prove running-service rejection,
clean-stop admission, snapshot and receipt replay. It never enables the fixture;
the stopped unit/evidence remain. Its sleep process does not simulate actual
Xaventra writers, and fixture authority is not distributed fencing evidence.

`NativeStateHelper` supplies the concrete copy/hash process adapter: fixed
enrolled paths, root-protected hash-pinned Node and `/usr/bin/setpriv`, nonzero
UID/GID, cleared supplementary groups, no-new-privileges and a minimal environment.
Only the trusted generated copy/hash programs run; no shell or caller-supplied
code. Process timeout, SIGKILL and output bounds are fixed by protected enrollment.
It validates executable identities and state-root ownership before/after execution.
The snapshot fixture now uses this real unprivileged helper instead of executing
the copy as root, and rejects wrong executable hashes and unenrolled hash paths.
An initial Linux negative run exposed Node including its effective GID in
`getgroups()` even after `--clear-groups`; the check now permits only that exact
primary GID, rejecting every other group. Failed fixture intent is retained.
This helper does not stop services or establish external writer quiescence, and
must be called through the guarded snapshot store under the activation lock.

`NativeSnapshotStore` composes the read-only mount observer with protected,
fsynced ticket/enrollment-bound intent and completion receipts. An exclusive
sub-operation lock prevents concurrent copying; failed/ambiguous intents retain
the lock and require reconciliation, never blind recopy. Completed replay hashes
both trees again; baseline rollback verification hashes only the preserved source
so legitimate candidate writes do not invalidate the original backup. Authority,
writer quiescence and mount identity are rechecked around the copy/hash work.
The copy and read-only hash helpers share the same bounded traversal and digest.
Real private-namespace acceptance now exercises protected receipts, reconstructed
store replay with exactly one copy, and rejection of a modified candidate while
the baseline still verifies. This is not process-crash/power-loss acceptance.
The operations adapter binds helpers through protected paths/UID/GID/timeouts;
production must supply real stopped-writer/external-fencing evidence. Fixture `fenced=true`
must never become production enrollment. No native controller has been activated.

`verifyNativeReadOnlyMount` now checks an exact enrolled Linux mount namespace,
device, root inode and filesystem, twice, with bounded kernel evidence. It rejects
links, stacked or nested mounts and, importantly, a read-only bind whose backing
filesystem remains writable. Both mount and superblock must be read-only.
This observer never mounts or changes production storage. A dedicated-filesystem
strategy still needs explicit enrollment; it must not silently remount the host
root filesystem to accommodate existing bind-based deployments. Privileged
remounts and external/Mesh writers require separate authority/fencing controls.
`scripts/check-native-state-mount.mjs` proves this distinction with actual private
namespace tmpfs mounts, kernel write rejection, three-way copy hashes and an
independent candidate mutation. It is not full snapshot receipt or rollback proof.

`createNativeStateCopyScript` reuses the Docker helper's bounded streaming
source/copy/source comparison. Native mode uses disjoint canonical enrolled
paths, uniform runtime UID/GID ownership and fsynced destination directories,
and emits three content hashes. Run `scripts/check-native-state-copy.mjs` on
Linux (or bundle it) for disposable filesystem acceptance. A copy hash is not
a writer fence: stopped processes, external quiescence, a read-only baseline,
protected receipt persistence and rollback validation still require adapter
integration. Never set `sourceReadOnly` solely from this helper result.

`NativeReleaseSelection` selects between root-protected, hash-pinned unit files
only while the enrolled service is cleanly stopped. It persists intent before
atomic replacement and reload, with a ticket/direction-bound receipt and owned
lock. Replay of completed selection does not reload again. Interrupted intent
requires reconciliation against the actual loaded unit; reconciliation never
blindly repeats a rename/reload. Full artifact/app-tree validation and external
writer fencing remain the enclosing native adapter's obligations.

`verifyNativeProcess` verifies a Linux PID incarnation (start ticks), executable
path and SHA256, exact argv, cwd and cgroup with bounded reads and repeated
observations. It never reads `environ`. Expected identities must come from
protected release/unit enrollment, not be copied from an untrusted process.
This verifies the executable, not loaded JavaScript modules, dependency content
or application readiness. `NativeSystemdService` now requires this enrolled
profile for running services, verifies it before stop and after start, and
rechecks the service manager's PID after verification.

Positive isolated lifecycle acceptance is available in
`scripts/check-native-systemd-service.mjs` (bundle for Linux; explicit
`XAVENTRA_NATIVE_FIXTURE=1`, root required). It creates only a unique fixture
unit, runs an unprivileged network-isolated Node process, checks readiness,
rejects a wrong executable hash before stop, and verifies clean stop. The unit
is never enabled; stopped fixture and evidence are retained. This does not test
production lease/fencing, snapshot or full update rollback. The fixture also
selects a distinct next program, proves its readiness, stops it and restores
the original unit. This is unit-selection acceptance, not signed artifact or
data rollback acceptance.

`NativeSystemdService` now provides a fixed `/usr/bin/systemctl` argv-only
transport and enrolled-unit inspect/stop/start checks. It rejects drop-ins,
changed unit content, pending daemon reload, ambiguous states, partial process
kill policies and automatic restart ownership. Authority is checked around
mutations. Release selection, process identity and snapshots are composed through
the separate components above; this transport alone does not establish external
writer fencing. Simulated tests and live read-only rejection must not be confused
with the separate positive isolated lifecycle fixture.

The operations interface is an operator-owned adapter boundary with a concrete
component composition, **not an enrolled production updater**. It requires fixed service and
filesystem operations, actual process identity/readiness, CAS selection, durable
snapshot receipts and real external-writer fencing. Production enrollment must
not replace these with constant-success callbacks. Publisher verification and
independent acceptance remain required in the outer controller.

Driver contract tests use simulated native operations and real signed tickets/shared
controller receipts. They cover install, rollback and restart/replay, mismatched
approval/state/snapshot identity, lost authority and missing fencing. They do
not alone demonstrate live systemd activation, backup, Telegram or production
safety. Other component fixtures above provide isolated OS evidence. The
production-facing factory uses independent signed release/application-tree
verification, not the fixture publisher callback. Complete-candidate publication,
actual Xaventra update/rollback and production fencing/storage enrollment are
still open. Isolated rollback is not RC clearance.


## Phase 4: watcher, plan and fencing readiness (read-only)

`src/core/self-update/` prepares self-activation without executing it (default off,
`autonomy.selfUpdate.enabled`, see AUTONOMY_GUIDE). The watcher verifies signed
releases with `verifyUpstreamManifest` against the pinned publisher key and
downloads only the manifest, `SHA256SUMS` and the small descriptors; it emits one
`fragen` thought per release. `buildActivationPlan` turns a verified release plus
node profiles into the runbook 3.4b/3.5 steps for native Spark and the worker swap
for containers (workers → NAS → Spark, NAS host never restarted) as hash-bound
data. `evaluateFencingEnforceReadiness` reports whether enforce would be safe,
including EXECUTE of the real PostgREST app role on the v5 RPCs. None of this is an
enrolled updater: host execution, controller enrollment, approval tickets and real
storage/writer fencing remain the open gates listed above.
