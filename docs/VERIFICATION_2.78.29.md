# Xaventra 2.78.29 verification

## Scope

This bounded candidate covers verified native tool-receipt persistence and
process-restart rehydration for a stable mission execution scope. It does not
claim cross-node mission takeover, production adoption or general RC readiness.

## Reproduction

Before this change, the idempotency result survived a process restart, but the
Execution Kernel's correlated verification receipt existed only in memory.
Reconstructed native runs therefore could not use the prior verified call as
completion evidence even though repeating the effect was prohibited.

## Implemented contract

- Persist only after `ExecutionKernel.verify` succeeds.
- Bind scope, principal, channel, contract fingerprint, idempotency key,
  execution-input hash and Kernel evidence.
- Keep raw arguments and raw results out of the receipt file.
- Rehydrate only from a completed, matching independent idempotency record.
- Reject changed results, another principal/channel, changed contracts,
  disallowed tools and duplicate call IDs.
- Persist completed idempotency keys in the Outcome Ledger checkpoint at each
  verified native call.

## Evidence

### Source and isolated regression

- TypeScript typecheck: passed.
- Build: passed.
- Focused receipt/authorization regression: 9/9 passed.
- Full Core regression: 227 files, 1,555 tests passed on Windows with two workers.
- Prior first full run retained: three authorization regressions exposed a new
  closure dependency and one publication fixture hit Windows nested-worktree
  path limits. The closure was corrected; the publication fixture passes with
  inherited `core.longpaths=true`. The final full run passes 1,555/1,555.

### Real isolated process acceptance

`node scripts/check-native-tool-resume.mjs` compiled and launched two distinct
Node processes over one disposable state directory. The first process executed
and verified the effect; the second rehydrated the receipt and called the same
idempotency key. Result: `processStarts=2`, `effects=1`, `rehydrated=true`,
`duplicateEffect=false`.

### Hosted platforms

Pending exact-candidate CI. The CI matrix is configured to run the same compiled
two-process acceptance on Windows, Linux and macOS.

### Live/production

Not run. No production instance was changed. Cross-node state replication,
fenced successor admission, node-loss takeover and production Telegram/Desktop
resume remain open gates.

## Rollback

Select the previous verified release artifact. The added receipt file is
additive. Older idempotency records without an input hash remain readable but
cannot be promoted to new verified receipts; they fail closed and require a new
governed execution.
