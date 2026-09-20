# Xaventra 2.78.37 verification

## Scope

This bounded candidate adds the missing operator surface between a persisted,
Doctor-generated repair proposal and the canonical `PATCH_GATE`. It does not
approve a patch automatically, create a second activation path or change any
production node.

## Evidence matrix

| Claim | Evidence | Status |
| --- | --- | --- |
| Only the configured Desktop owner can list or approve Doctor proposals | `desktop-api.test.ts`, full-daemon Desktop acceptance | passed locally |
| Patch contents, raw sandbox output, signatures and tokens are not returned | API negative regression and packaged acceptance | passed locally |
| Approval requires current Main and dashboard fencing | API negative regression | passed locally |
| Approval uses the canonical `approveEvolutionProposal` boundary | API regression and implementation review | passed locally |
| Packaged UI shows reproduction, regression, cleanup, rollback and recovery evidence | packaged Electron acceptance | passed locally |
| Rejected approval and full daemon restart preserve exactly one queued proposal | packaged Electron-to-full-daemon restart acceptance | passed locally |

## Commands run locally

- `npm run typecheck`
- `npx vitest run src/desktop/desktop-api.test.ts`
- `npm run build`
- `npm run build --prefix desktop`
- `npm run check:desktop-daemon`

## Known limits

- The acceptance uses a synthetic proposal and disposable daemon data. It is
  not a production activation, physical-node failover or live signing test.
- Signing identities and native package notarization remain external release
  prerequisites.
- Candidate CI, full-history secret scanning and evidence-commit CI are still
  required before promotion.

## Candidate evidence

- Candidate commit: pending.
- Candidate CI: pending.
- Full-history secret scan: pending.
- Evidence-commit CI: pending.
