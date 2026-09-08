# Doctor candidates and controlled activation

For the 2.78.16 Docker adapter, separate authority service, state snapshot gate
and continuous acceptance, see [Docker repair](DOCKER_REPAIR.md). Existing
container deployments are not implicitly migrated or enabled by installation.

The 2.78.15 workflow is:

verified Doctor observation -> bounded model candidate -> exact isolated sandbox
-> queued proposal -> owner PATCH_GATE -> signed immutable release activation
-> independent original predicate -> signed recovery receipt.

The model cannot choose a probe URL, signing key, production command or target.
Passing sandbox tests is not live recovery. A failed live predicate triggers a
typed rollback; restoring the old, faulty behaviour is recorded as **rolled-back**,
not repaired. Unknown transport, missing signatures, lost authority and ambiguous
restart/rollback retain a blocked/pending state, not a success report.

## Operator prerequisites (not installed automatically)

1. Configure the trusted dependency image described in [the sandbox guide](REPAIR_SANDBOX.md).
2. Store local, private profiles in `.nova-data/self-doctor/repair-profiles.json`:

   ```json
   [{"id":"answer-repair","findingId":"observed-finding-id","file":"src/example.ts","reproductionTest":"src/example.test.ts","probeId":"original-answer","targetId":"managed-runtime"}]
   ```

   These are operator policy, not model output or issue instructions. The source
   file must be regular, bounded and secret-free. A Doctor report without a
   suitable profile remains diagnostic-only. Invalid/unsupported candidates and
   interrupted generation remain visible and are not repeatedly auto-replayed.
3. Prepare a clean source mirror matching the currently running release. Set
   `XAVENTRA_REPAIR_SOURCE_ROOT` if it is separate from the runtime data directory.
   Do not update this mirror by stashing or overwriting user changes. After a
   release, advance it through the reviewed release pipeline; stale baselines
   fail closed. Automatic mirror advancement is not implemented by the adapter.
4. A separate reviewed build/signing pipeline prepares immutable artifacts. The
   controller does **not** compile a proposed patch on the production host or
   blindly sign model-generated code. Each release directory contains
   `repair-release.json`, an Ed25519 `{payload, signature}` envelope. Its payload:

   ```text
   id, previousReleaseId, sourceHash,
   binding: {proposalId, patchHash, baselineHash, candidateHash, probeId, targetId},
   files: [{path, sha256}, ...]
   ```

   `sourceHash` is the canonical sandbox source snapshot hash independently
   attested by the builder, not the output-directory hash. Every artifact file
   including dependencies is listed, regular and hash-verified. Links and
   unlisted inputs fail. The prior artifact's sourceHash must match the ticket's
   baselineHash; a second repair cannot silently discard the first. The operator
   maintains a protected `catalog.json` mapping candidateHash to release ID.
5. Install the controller from a trusted build **outside** replaceable release
   directories. The included managed adapter is specifically for a standalone
   Linux Node process, root controller and separate positive runtime UID/GID.
   State, keys, releases and their ancestors are root-owned and not group/world
   writable. The application owns only its runtime data. Do not concurrently run
   PM2/systemd/Docker automatic restarters against that process.
   The private controller configuration and receipt signing key additionally
   require mode 0600/0400: merely root-owned but world-readable keys are refused.

   Start explicitly with `node scripts/repair-controller.mjs /protected/controller.json`.
   Configuration contains `targetId`, `releasesRoot`, `runtimeRoot`, `stateFile`,
   `stateRoot`, `initialReleaseId`, `runtimeUid`, `runtimeGid`, `runtimeEnv`, `port`,
   optional root-owned `nodeExecutable`,
   `approvalPublicKeyFile`, `receiptPrivateKeyFile`, `releasePublicKeyFile`,
   `authorityPublicKeyFile`, `authorityUrl` and `probes`. Never commit this config.

   `authorityUrl` is an operator-configured HTTPS or loopback service signing
   `{challenge,targetId,patchHash,bindingHash,allowed,expiresAt}` with a short expiry.
   `bindingHash` must match the complete ticket sent with the challenge. It must
   validate the deployment's current authority/fence; there is no default
   allow-all or inferred Main. The adapter does not implement distributed quorum.

   Each probe is `{id,targetId,url,expectedStatus,expectedBodySha256}`. The
   controller freezes this configuration before loading candidate code. It
   independently fetches the exact GET predicate, without redirects, with fresh
   challenges and bounded time/body size. Transport failure is **unknown**, not
   a reproduced application fault. Dynamic/credentialed or non-HTTP workflows
   need a separately reviewed predicate adapter; do not substitute `/health`
   when the original failure concerns a different operation.

6. The approving runtime requires `NOVA_PATCH_GATE_TOKEN`,
   `XAVENTRA_REPAIR_CONTROLLER_URL`, `XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY` and
   `XAVENTRA_REPAIR_APPROVAL_PRIVATE_KEY`. These are local private settings.
   The approval signing identity is distinct from controller receipt, release
   and authority signing keys. Only the latter keys must stay inaccessible to
   the candidate runtime. Runtime variables are explicitly allowlisted by the
   operator; the controller does not inherit/copy its own environment into it.
   Never put keys into memory, proposal metadata, model input or Git.

## Operation and recovery

`/patches` shows queued patches. `/patch approve <id>` and Telegram's approval
button use the same exact-ID boundary, preserving the reproduction oracle.
Direct apply requests without a bound queued proposal are deliberately refused.
Approval never changes the source checkout. A clean unchanged snapshot and
complete sandbox evidence are mandatory before dispatch.

`/patch status` polls signed durable controller receipts. The normal enabled
autonomy cycle also reconciles one pending activation, including after restart.
The controller survives the old runtime; only it may report independent recovery.
Signed receipts are retained and reverified before closing a Doctor case.
Config-only Doctor proposals remain a separate schema-validation path, not a
claim of sandbox, restart or independently verified healing.

If an attempt times out, do not issue another deployment. Preserve proposal,
ticket, receipt and `activation.lock`. On controller crash or unverified rollback,
the retained lock prevents guessed retries. The operator must verify the actual
runtime identity, process exit, artifact and original probe before reconciling
the lock. Never delete it merely because it is old. Database/schema migrations,
external side effects and shared-volume rollback are not generically reversible;
use a workflow-specific recovery plan. No production rollout is authorized by
installing this source.

## Acceptance classes

- Source tests: candidate parsing, scope/authority, signatures, replay, stale
  observations, failed recovery, rollback and exclusive ownership; scripted
  model/driver receipts are explicitly not live model outcomes.
- `node scripts/check-repair-activation.mjs`: real signed HTTP controller and
  disposable child-process replacement/rollback, independent parent predicate;
  test deployment adapter on Windows/Linux/macOS, not fleet deployment.
- `sudo node scripts/check-managed-repair.mjs`: disposable **Linux CI only**,
  actual managed adapter, signed root-owned releases, non-root runtime, denied
  host-canary write, prior-repair preservation and verified rollback. Do not
  run against production or reuse its fixture identities/authority callback.
- `node scripts/check-repair-sandbox.mjs`: actual isolated build/regression/
  rollback/restoration, separate from the live-controller predicate.

All reports retain failures and exact source revisions. These bounded predicates
do not prove arbitrary self-repair, Doctor model quality, all 40 modules or RC
readiness. Existing container deployments require an appropriate reviewed
container adapter; they must not be silently switched to the process adapter.
