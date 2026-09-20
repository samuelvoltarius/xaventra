# Xaventra 2.78.36 verification

## Scope

This bounded candidate closes one crash-consistency gap between a
Doctor-generated, sandbox-verified source proposal and the persisted
`PATCH_GATE` state. It does not enable autonomous approval or production
activation and is not a claim of complete self-repair.

## Evidence matrix

| Claim | Evidence | Status |
| --- | --- | --- |
| Doctor correlation is persisted with the queued proposal | `repair-candidate.test.ts`, `self-evolution-sandbox.test.ts` | passed locally |
| A restarted coordinator reattaches exactly one intact proposal | compiled disposable Docker repair acceptance | pending CI |
| Reconciliation requires reproduction, regression, cleanup, rollback and recovery proof | source regression and Docker sandbox phases | passed locally / pending Docker CI |
| Tampered state cannot advance to `PATCH_GATE` | negative source regression | passed locally |
| No automatic approval or activation occurs | source regression and Docker live-answer negative check | passed locally / pending Docker CI |

## Commands run locally

- `npx vitest run src/doctor/repair-candidate.test.ts src/synthesis/self-evolution-sandbox.test.ts`
- `npm run typecheck`

## Known limits

- The disposable Docker acceptance is not a production-node test.
- Operator signing identities, live leases and production rollout remain
  external and unchanged.
- A proposal interrupted before its atomic persistence is not regenerated
  automatically; it remains fail-closed for investigation.
