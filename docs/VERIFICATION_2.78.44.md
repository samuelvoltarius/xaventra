# Xaventra 2.78.44 verification

## Scope

This bounded candidate closes the Agents SDK half of durable verified-tool
resume. It does not claim physical-host failover, production channel continuity,
native installer signing, or full RC readiness.

## Reproduced defect

The optional Agents SDK backend used persistent idempotency for execution but
did not persist its verified kernel receipts. Approval checkpoints always wrote
an empty `completedIdempotencyKeys` array. After a process or node restart, the
new `ExecutionKernel` therefore could not validate work completed before the
interruption, and successor nodes had no fenced import path for the result.

## Fix

- Every successful SDK tool call binds its durable result to a verified receipt
  containing only hashes and scope metadata; raw arguments/results are not
  duplicated into the receipt store.
- Approval checkpoints retain completed keys and the serialized SDK state.
- Resume reconstructs receipts before running the SDK and fails closed for a
  missing key, result mismatch, principal/channel mismatch or changed contract.
- Mission-scoped runs publish/import the receipt plus idempotency record through
  the authenticated three-witness checkpoint transport under the active epoch.
- Terminal validation marks the durable SDK checkpoint completed.

## Local evidence

- TypeScript typecheck: passed.
- Focused regressions: 3 files, 8 tests passed.
- Full Core: 231 files, 1,587 tests passed. The first run retained one unrelated
  Windows long-path failure in the repair-publication fixture; that focused file
  passed 8/8 and the unchanged full suite passed with a process-local
  `core.longpaths=true` Git setting. No global Git setting or test was changed.
- Desktop unit tests: 12/12 passed. Static reachability, canonical state,
  terminal completion, generated catalogs and Assurance passed; Assurance has
  no high/critical finding and retains the external-comparison warning.
- Compiled acceptance: passed on Windows with two isolated node processes,
  three authenticated durable witness services, one real SDK approval
  interruption, one successor resume, exactly two intended effects, no replay,
  canonical terminal validation and stale-writer rejection.

The first authored test accidentally recreated its scripted model on every turn
and retained a `MaxTurnsExceededError` during development; correcting the test
fixture, without changing runtime expectations, produced the intended approval
interruption. This was fixture evidence, not a product failure.

## Pending release evidence

The exact candidate commit still requires candidate CI on Ubuntu/Windows/macOS,
evidence-commit CI, complete-history secret scan, normal
fast-forward to `main`, green main CI and the signed release workflow. Until
those gates pass, 2.78.44 remains a candidate and production is unchanged.
