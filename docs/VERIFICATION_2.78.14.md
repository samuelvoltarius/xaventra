# 2.78.14 — isolated preapproval repair sandbox

Scope: close the path from generated patch input through preapproval compiler/
test execution to host credentials/files/network. Preserve proposal semantics
and PATCH_GATE; do not claim the legacy approved production transaction safe.

## Ordered verification

- TypeScript: `npm run typecheck`.
- Boundary triggers and alternate representations:
  `npx vitest run src/synthesis/patch-sandbox.test.ts src/synthesis/self-evolution-sandbox.test.ts src/synthesis/synthesis.test.ts --maxWorkers=2`.
  Final local Windows result: 51/51 tests. Docker is scripted here, explicitly
  not a live isolation proof. Cases cover canonical paths, links, excluded config,
  limits/argv, failing commands, cleanup, changed snapshots, original-symptom
  expectations, queue gating and concurrent dispatch.
- Legitimate path: exact replacement, unchanged tests, original/candidate hash
  restoration and queue-without-application use those same production entry points.
- Owning package locally passed: 200 Core files / 1344 tests, build, 7 Desktop
  tests, generated catalogs and assurance. Redacted staged and 30-commit public
  history secret scans found no leaks. These do not replace exact-SHA CI.
- Real backend: new Linux CI job runs `scripts/check-repair-sandbox.mjs` against
  a dedicated dependency image and disposable source fixture. Reports include
  exact commit, dirty state and all failed checks. Exact-revision green CI is
  required before promotion; no local mock is substituted for that gate.

Local Docker Desktop engine was unavailable at the start of this round (missing
Linux engine named pipe); no production engine or service was changed. Record
the real backend result from CI separately. Preserve negative reports.

Initial candidate `c701387867b35af774ef905158ef33ea27be07df`, CI `34238112131`,
retains a negative real-container report: Vite required a writable temporary
cache directory beside dependencies, and bracketed repository routes were
over-rejected by the snapshot path filter. Dependencies now remain read-only
image links individually inside a disposable writable node_modules directory;
canonical bracketed/Unicode filenames are accepted without accepting traversal.
No confinement flags or regression assertions were relaxed. The same CI also
  retains a packaged Linux screenshot timeout, separate from the sandbox defect.

Runtime commit `72fa75eea3f87da71bdd359cad4c58d5971eb821` passed all eight jobs in
[CI 34238645175](https://github.com/samuelvoltarius/xaventra/actions/runs/34238645175).
Downloaded Linux report confirms exact clean source and all five real checks:
four-phase fixture restoration, complete source build/regression through all
four phases (1342 Core tests at that revision), blocked host write, retained
matcher-tampering negative control and unchanged host source. Every container
cleanup was verified. Core and packaged Desktop jobs passed on all three OSes.
The subsequent SIGKILL/deadline strengthening adds a sixth actual-container
check for non-cooperating code and needs its own exact-revision green CI before
promotion. The earlier green run is not substituted for that final check.

The hardened runtime `9b5edd06ea972c36a4334cc8164f57f7c3e24685` also passed all
eight jobs in [CI 34239802665](https://github.com/samuelvoltarius/xaventra/actions/runs/34239802665).
Its downloaded clean-source report passes all six real checks, including forced
termination and verified cleanup of a candidate ignoring SIGTERM. A subsequent
caller-only correction removes the obsolete inner lock release: only the outer
async owner may release the evolution lock. The new deterministic competing-call
test fails with the early release (a second proposal starts), then passes with
the fix. This final ownership/attestation change must likewise pass its own
exact-commit CI. These records do not authorize deployment or full RC acceptance.

## Limits kept open

Independent review reproduced Vitest matcher replacement without repairing the
tested value. Consequently sandbox results explicitly keep `symptomVerified`
false; only `reproductionPassed` describes the bounded in-process regression.
The live fixture retains this negative semantic control. Review also identified
compiler repairs being rejected at baseline; failed compiler baselines are now
recorded and must reappear on rollback, while both candidate builds must pass.

- Automatic Doctor-to-source-candidate generation and production activation are
  not implemented by this patch; the diagnostic worker remains read-only.
- A clean sandbox does not certify rollback of the existing approved Git/build/
  restart transaction or external effects. Original production health recovery,
  crash reconciliation and multi-node repair ownership still need acceptance.
- Container isolation depends on a trusted engine/image/kernel and checked-in
  source; not a VM boundary or cryptographic independent semantic validator.
- Missing Docker/cgroup v2/image identity is fail-closed. No production rollout,
  platform-wide Docker guarantee or complete RC/40-module functional claim.
