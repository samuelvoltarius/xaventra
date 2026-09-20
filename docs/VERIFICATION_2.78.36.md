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
| A restarted coordinator reattaches exactly one intact proposal | compiled disposable Docker repair acceptance | passed in CI |
| Reconciliation requires reproduction, regression, cleanup, rollback and recovery proof | source regression and Docker sandbox phases | passed locally and in CI |
| Tampered state cannot advance to `PATCH_GATE` | negative source regression | passed locally |
| No automatic approval or activation occurs | source regression and Docker live-answer negative check | passed locally and in CI |

## Commands run locally

- `npx vitest run src/doctor/repair-candidate.test.ts src/synthesis/self-evolution-sandbox.test.ts`
- `npm run typecheck`

## Known limits

- The disposable Docker acceptance is not a production-node test.
- Operator signing identities, live leases and production rollout remain
  external and unchanged.
- A proposal interrupted before its atomic persistence is not regenerated
  automatically; it remains fail-closed for investigation.

## Candidate evidence

- Candidate commit: `feb7de5f52f85aaa10276cf76abc6c5f9e7245c1`.
- [CI 35527631017](https://github.com/samuelvoltarius/xaventra/actions/runs/35527631017): all ten jobs passed, including the real Docker Doctor-to-repair path,
  independent sandbox rollback/restoration, three operating-system verification
  jobs and three packaged Desktop smoke jobs.
- Gitleaks 8.30.1 scanned all 102 public commits (10.83 MB) with zero findings.
- This evidence commit still requires its own green CI before `main` can move.
