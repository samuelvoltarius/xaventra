# Xaventra 2.78.30 verification

## Scope

This bounded candidate covers replication and fenced successor admission of
verified native tool receipts and completed idempotency results. It does not
claim a production Mesh failover, physical-node loss test or general RC
readiness.

## Reproduction

Version 2.78.29 could reconstruct native Kernel evidence after restarting the
same node, but a successor did not possess the completed idempotency record or
receipt. Repeating the operation was therefore unsafe and completing the
mission from verified prior evidence was impossible.

## Implemented contract

- Mirror only completed records with a matching verified receipt.
- Encrypt the bundle through the existing HA state transport.
- Revalidate the live mission lease before both publication and import.
- Require the exact current mission ID, fencing epoch and token at admission.
- Accept the authority's colon-delimited token format in the native mission
  marker; a regression covers the exact emitted shape.
- Bind mission scope, principal, channel and TaskContract across nodes.
- Reject changed results, mismatched bindings, future epochs and conflicting
  local durable records.
- Restore Kernel evidence and replay the recorded result without executing the
  effect again.

## Evidence

### Source and isolated regression

- TypeScript typecheck: passed.
- Build: passed.
- Focused takeover, receipt and idempotency regression: 13/13 passed.
- Full Core regression: 228 files, 1,558 tests passed on Windows with four
  workers. Exact hosted-CI counts are recorded only after the candidate commit
  completes.

### Real isolated process acceptance

`node scripts/check-native-tool-takeover.mjs` launches three distinct Node
processes. Process A executes one effect and publishes its bound checkpoint.
The fixture authority advances from epoch 1 to epoch 2. Process B imports under
epoch 2 and receives the recorded result without invoking its duplicate-effect
callback. A third stale-epoch process is rejected. Windows result:
`processStarts=3`, `effects=1`, `staleWriterRejected=true`,
`duplicateEffect=false`.

The authority and HA transport in this acceptance are shared disposable files.
They exercise compiled process boundaries and production serialization/admission
logic, but do not attest Supabase availability, a real network partition or a
physical node takeover.

### Hosted platforms

Pending exact-commit CI. The candidate workflow runs the same compiled
three-process acceptance on Windows, Linux and macOS and preserves its report as
an artifact even on failure.

### Live/production

Not run. No production instance was changed. Controlled live coordinator
takeover, external-writer fencing and production Telegram/Desktop resume remain
open RC gates.

## Rollback

Select the previous verified release artifact. The HA checkpoint scope and local
imports are additive. A downgraded node ignores the new scope; conflicting local
durable records are never replaced during upgrade or rollback.
