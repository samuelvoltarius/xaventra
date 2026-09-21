# Xaventra 2.78.43 verification

Date: 2026-09-21

## Scope

This candidate closes one objective-1 blocker: terminal success must be written
through one persisted Execution Kernel validation contract. It does not claim
physical-node failover, production rollout, native signing or notarization.

## Source checks on Windows x64

- TypeScript typecheck: passed.
- Core build: passed.
- Focused ledger/native/SDK/Doctor/router regressions: 48/48 passed.
- Full Core regression: 231 suites, 1,585 tests passed.
- The first full run retained one negative timing result in the disposable
  repair-publication fixture (5-second timeout); its isolated rerun passed 8/8,
  and the unchanged full rerun passed 1,585/1,585.
- Desktop unit regression: 12/12 passed.
- Desktop unpacked Windows package build: passed after network access was
  granted for the locked Electron runtime download.
- Runtime import check: 9 core modules and 40 service modules loaded.
- Static layer graph: all 40 service modules reachable; this remains static
  reachability evidence, not functional acceptance.
- Runtime catalogs: current.
- State-authority acceptance: 19/19 passed.
- Assurance gate: passed with zero production dependency findings; the external
  comparison warning remains open. A separate full npm audit reports two
  moderate development-only Vitest findings and no high or critical finding.

## Real disposable acceptance

`npm run check:completion-authority` runs the compiled distribution against an
isolated Outcome Ledger. All 9 checks passed:

- no success before validation;
- no success from a spoofed validator;
- canonical Execution Kernel validation accepted;
- exactly one terminal success commit;
- duplicate completion rejected;
- imported unvalidated success projected as failed and invalidated.

## Hosted evidence still required

Candidate CI must run the identical acceptance on Ubuntu, Windows and macOS.
The first candidate run is retained as negative evidence: the pre-existing
Outcome Router process acceptance still called the intentionally removed raw
ledger APIs and failed on Ubuntu. The fixture now uses the public contract
methods and `completeValidated`; a new exact-revision run is required.
The candidate revision, downloaded reports, complete history scan, evidence
revision, main CI and signed release publisher must be recorded before this
candidate can be called published. No production node was modified.
