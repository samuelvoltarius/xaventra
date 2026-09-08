# 2.78.13 — persistent goals and executable Doctor investigations

Base: `be756cb66fe0860f9bb9e888c397cdf9977d2c2b` (2.78.12), with green
[main CI 34217978407](https://github.com/samuelvoltarius/xaventra/actions/runs/34217978407).
This is a bounded source correction, not an RC or production deployment.

## Reproduced failures and fix

- Before patching Goal Manager, the first ten new tests produced **eight
  failures and two passing controls**. Explicit blocks were cleared by reads
  or completed dependencies; children under blocked/terminal parents were
  selected; missing prerequisites and cyclic ancestry did not prevent selection.
- A separate two-test native mission reproduction failed both checks: pausing
  did not block the goal projection, and initialization ignored paused saved
  missions. These negative observations are retained here, not retroactively
  counted as passes.
- Stored `blockedBy` distinguishes explicit blocks from dependency blocks.
  Existing blocked records without a reason are conservative explicit stops.
  Dependency-only blocks can recover when their prerequisite explicitly changes;
  they cannot override a subsequent explicit stop. Changed readiness is persisted.
- Selection checks the complete ancestor chain and prerequisites. Parent
  aggregation records progress but cannot undo blocked or terminal status.
  Replaying a completed mission plan does not recreate executable steps.
- Native initialization restores paused checkpoints. Active startup recovery
  blocks the goal projection until it acquires a fresh mission fence and checks
  that the same mission is still active before/after awaiting ownership.
  Explicit pause blocks the root goal, including on subsequent restart.

## Reproduction and evidence classes

Run from a disposable source checkout with only the checked-in example config:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test -- --maxWorkers=2
npm run build
node scripts/check-layer-contracts.mjs
npm run test:desktop
npm run check:catalogs
npm run check:assurance
```

The sixteen new source cases use temporary data and include successful
dependency progression/explicit resume as controls. Compiled checks use real
disk persistence and actual exported Goal Manager/mission APIs with synthetic
missions, no network, no external model and no production credentials. They
are not live distributed acceptance. Reports record source SHA, dirty flag,
platform and case results; CI retains failures as well as successes.

Local Windows build/typecheck, ten compiled contract cases, seven Desktop
bridge tests, static 40-module reachability, catalogs and assurance passed.
Full Core regression passed: **195 files / 1298 tests**, including all sixteen
new source cases. Exact candidate CI results are recorded below when known.
The pre-commit compiled report explicitly identifies a dirty base revision.

## Upgrade, stop and rollback

1. Stop the daemon through its scoped service/CLI control and back up its
   runtime data with restrictive permissions. Do not copy private state to Git.
2. Build/test this candidate separately before selecting it for deployment.
   Preserve `goals.json` and `missions.json`; no reset or historical import is
   needed. The optional block metadata is additive to the existing v1 file.
3. After startup, inspect paused missions and explicitly resume only when their
   original blocker is resolved and policy/lease checks permit it. Old ambiguous
   blocks do not silently resume; no automated approval is inferred.
4. A rollback to the predecessor restores its buggy readiness behavior. Keep
   autonomous execution disabled/daemon stopped during such a rollback until
   paused state has been reviewed; do not treat schema compatibility as safety.
   No production update or rollback was performed for this source round.

## Open acceptance gates

The subsequent Doctor connection is documented in
[autonomous repair: implemented path and open boundary](AUTONOMOUS_REPAIR.md).
The former prose-length completion path is replaced, not kept as a competing
executor. The new tests include the actual native runner and ledger with a
scripted model, explicitly separate from the optional live-model investigation.
The 1298 count above is the earlier goal-only regression, not the final count
after adding Doctor tests.

Local Core regression after connecting Doctor: **197 files / 1311 tests**
passed on Windows. The real local `qwen` model also passed the opt-in disposable
HTTP investigation: it called the scoped probe tool, identified the mismatched
configured/listening ports and proposed retesting the corrected endpoint. The
probe config remained unchanged, and the case remained `researching`, not
`resolved`. This was a dirty-tree pre-commit live-model run, not an exact clean
commit attestation or a completed autonomous repair. The checked-in opt-in
script reproduces it without requiring anyone's private topology or credentials.
An additional targeted autonomy-cycle regression passed after that full run:
Doctor dispatch is no longer starved by the ordinary self-goal startup/idle
early return. Exact candidate CI must include this final regression too.

- Whole-module function acceptance remains open in the
  [40-module matrix](LAYER_BEHAVIOR_MATRIX.md).
- The native executor remains the execution owner; this patch does not add a
  second arbitrary-goal dispatcher. Event-to-goal-to-governed-tool execution,
  timeout abortion, cancellation races and exactly-once external effects still
  need end-to-end proof. Goal state is not an authorization/validator receipt.
- Live HA fencing, mission takeover, memory convergence, external channels and
  complete governed Doctor repair remain open. So do rich blocker reasons,
  graph retention/compaction and distributed goal reconciliation.
- The predecessor had an intermittent macOS packaged-Desktop reconnection
  failure (CI 34217404512, attempt 1); its unchanged retry passed, but the cause
  remains unresolved. This goal patch does not claim to fix that UI failure.
- Native installer signatures/notarization and tested install/update/rollback
  remain separate external/release gates. No feature was removed from scope.
