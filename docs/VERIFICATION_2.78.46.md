# Xaventra 2.78.46 verification

## Scope

This candidate replaces one unsafe generic recovery boundary: after an actual
tool failure, model prose no longer selects a recovery tool or `build_skill`.
The change does not claim general self-repair or production repair activation.

## Invariants

- Only an independently observed tool failure enters this path.
- Failure text is redacted evidence, never a command, tool selector or grant of
  authority.
- One canonical run/tool pair produces one persisted escalation record.
- A principal has at most one pending clarification; an existing question is
  never overwritten.
- Doctor escalation is read-only and remains subject to its existing bounded
  worker, independent validation, sandbox, regression, rollback and PATCH_GATE
  contracts.
- The original task remains failed until its required tool evidence succeeds.

## Evidence classes

| Evidence | Status | Boundary |
|---|---|---|
| Focused unit, authorization and native-runner regressions | 17/17 passed locally | Source/process |
| Typecheck and compiled build | Passed locally | Source/build |
| Two-process native-runner escalation acceptance | Passed locally | Compiled process/restart |
| Full Core regressions | 233 files / 1,607 tests passed locally | Local regression |
| Desktop regressions | 12/12 passed locally | Local process |
| Packaged Desktop UI/Core smoke | 10/10 UI and 5/5 actual-Core checks passed locally | Packaged process |
| Layer/catalog/state/completion/assurance gates | Passed locally | Static + compiled process |
| Ubuntu, Windows and macOS CI artifacts | 3/3 passed on exact candidate SHA | Hosted process/restart |
| Production Doctor or repair activation | Not claimed | Live production |

The compiled acceptance runs the native agent with a scripted provider and an
actual registry handler that returns an opaque failure. It verifies exactly one
model turn, exactly one failed tool effect, no `build_skill` effect, a persisted
Doctor case and escalation, canonical task failure, then starts a second Node
process and proves the same evidence is deduplicated without resubmission.

The first full regression retained two failures: an obsolete source call-site
count after deleting the two unsafe recovery loops, and Windows Git rejecting a
deep disposable repository path. The authorization regression now asserts the
remaining three governed call sites and absence of the removed recovery
markers. The unchanged publication test passed with process-local
`core.longpaths=true`; the complete rerun then passed 1,607/1,607. A first QA
acceptance rerun also exposed cached cwd-relative idempotency evidence. Its two
child processes now change into the disposable runtime before importing Core,
so every run proves one fresh failed effect rather than reusing prior QA state.

This is bounded scripted-provider and local-process evidence. It does not prove
native model diagnostic quality, production repair activation, a physical-node
failover or a released RC.

## Hosted candidate evidence

Candidate commit `0c809c6b94e290af40c0f425105a7a099547c02a`
passed all ten jobs in
[CI 35623661385](https://github.com/samuelvoltarius/xaventra/actions/runs/35623661385).
Downloaded Ubuntu, Windows and macOS `tool-failure-escalation-qa` artifacts each
report the exact clean candidate revision and all eight checks passing: one
model turn, one failed effect, no `build_skill` effect, deterministic response,
persisted escalation and Doctor case, canonical failed outcome and
cross-process deduplication. Gitleaks 8.30.1 found no secret across 124 public
commits / about 11.08 MB. This evidence attestation still requires its own green
CI before main promotion.
