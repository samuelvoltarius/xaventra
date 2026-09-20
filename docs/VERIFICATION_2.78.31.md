# Xaventra 2.78.31 verification

## Scope

This candidate covers live witness-coordinated transfer of a native mission
checkpoint and fencing of the predecessor's external checkpoint writer. It does
not claim production activation, a physical-node loss test, network-partition
coverage or general RC readiness.

## Reproduction

Version 2.78.30 validated successor reconstruction with separate Node
processes, but its authority and checkpoint transport were shared files. The
checkpoint sink itself did not independently reject a stale writer, leaving a
time-of-check/time-of-use boundary between lease validation and publication.

## Implemented contract

- Run checkpoint reads and writes through exactly three unique authenticated
  witness endpoints when witness coordination is configured.
- Require two witnesses to confirm the live holder node and exact mission lease
  epoch for every operation.
- Bind the checkpoint payload's source epoch to the accepted writer epoch.
- Accept a read value only when two witnesses return the same checkpoint ID and
  payload hash; count at most one vote per witness and value.
- Preserve the verified receipt, idempotency-result and TaskContract checks from
  2.78.30 before reconstructing Kernel evidence.
- Fall back to the existing encrypted HA transport outside witness mode.

## Evidence

### Source and isolated regression

- TypeScript typecheck: passed.
- Build: passed.
- Focused takeover, receipt, idempotency and witness regressions: 4 files,
  16 tests passed on Windows.
- Full Core regression: 228 files, 1,559 tests passed on Windows with four
  workers.

### Real isolated process acceptance

`node scripts/check-native-tool-takeover.mjs` starts three authenticated HTTP
witness services with independent durable state. A predecessor Node process
executes one effect and publishes its checkpoint, then exits. After lease
expiry, a successor process acquires epoch 2, reconstructs the verified receipt
and replays the stored result without invoking the effect. A stale predecessor
process then attempts a direct external checkpoint write and is rejected by the
witness quorum.

Initial Windows result: `nodeProcessStarts=3`, `witnessServices=3`, `effects=1`,
`staleWriterRejected=true`, `duplicateEffect=false`.

The services use real loopback HTTP, request/response HMAC authentication and
separate persisted witness stores. They run on one disposable test host; this
does not emulate a network partition or prove physical independence.

### Hosted platforms and public history

Pending exact candidate CI and full-history secret scan.

### Live/production

Not run. No production instance was changed. Independent-host witness loss,
physical node takeover, Telegram/Desktop continuity and production memory
convergence remain open RC gates.

## Rollback

Select the previous verified release artifact. The witness checkpoint endpoints
and stored checkpoint fields are additive. Older nodes continue to use the
encrypted shared-memory transport and do not consume witness checkpoint state.
