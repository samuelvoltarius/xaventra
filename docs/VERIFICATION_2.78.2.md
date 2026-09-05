# Xaventra 2.78.2 verification record

This iteration closes the broad process-stop defect found after
[2.78.1](VERIFICATION_2.78.1.md). It does not declare every distribution gate closed.

Local verification on 2026-09-05: **164 test files / 1,073 tests passed**,
four Desktop bridge tests passed, and build, typecheck, catalogs, freshness and
assurance passed. The actual compiled Windows daemon reached the lifecycle
test's ready condition in 15.270 seconds and exited normally through CLI stop in
159 ms. These single-run timings are not a cross-version speed comparison.
The separate real local-model suite passed **8/8** again at 21:32 UTC.

## Behavior changed

The old Unix CLI used a process-name match; the Windows/npm helpers also matched
window titles or whichever process held port 3000. They could stop another
instance, fail to stop the intended one, or report success without proof.

The replacement uses a fresh process identity and random local credential. Only
the matching daemon can accept the typed request, and the CLI waits for real
process exit. The process probe sends signal zero only (existence check), never
a terminating signal. A mismatch, unresponsive/old control channel, lingering
process or replacement PID prevents the automatic restart path from proceeding.
Supervised services must be managed through their own service manager.

The generated credential is local process-control state, not user memory or a
provider token. It must not be exported, logged, shared with Mesh or included in
support bundles. The new control channel is bound exclusively to IPv4 loopback.

## Reproducible checks

- `npm test -- src/process/daemon-control.test.ts`: no-instance behavior;
  legacy/mismatched identities; wrong credentials, instance IDs and PIDs;
  idempotent requests; acknowledgement without exit; replacement PID detection;
  malformed/foreign records; ownership-preserving cleanup; two actual child
  processes; actual CLI restart refusing to launch after an unverified stop;
  and npm alias wiring.
- `npm run build && npm run check:daemon`: launch the compiled daemon with a
  disposable home and inert configuration, a scripted loopback model, no
  messaging account or Mesh peers; require authenticated status with the correct
  package version, reject unauthenticated status, invoke the compiled CLI stop,
  and verify exit code zero and removal of this instance's control/PID markers.
- The same lifecycle check runs on Windows, Linux and macOS in GitHub CI. The
  exact-commit result, not the workflow's existence, establishes a platform pass.
- Reports and diagnostic logs remain in the printed temporary artifact directory.
  A failed fixture may be cleaned up only through its own child-process handle.

The scripted model in the lifecycle test is not real-model task evidence. The
separate eight-case local-model acceptance suite remains necessary for tools,
reasoning and scoped restart memory. Live Telegram, distributed failover,
interactive packaged Desktop QA and signed binaries remain separate gates in
[the release plan](RELEASE_PLAN.md). No production node was updated here.
