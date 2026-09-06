# 2.78.10 — grounded Doctor input and advisory-only recovery boundary

Status: bounded source checkpoint, **not RC-ready**. Base commit:
`cad05d415c6025f61903fe25ac03d5efa5c10088`. Candidate CI and exact source evidence
must be recorded before main promotion. No production, model weights or private
configuration changed. Native binary/signing gates remain separate.

Local source checks: 185 files / 1250 Core tests, seven Desktop bridge tests,
typecheck/build, current catalogs, five compiled artifact cases, fifteen compiled
API cases and assurance checks passed. Full-history and staged secret scans must
also pass for the exact candidate. Initial commit `4623d5df896e70418081dc41151c2730050844bb`
passed all seven jobs in [CI 34049928036](https://github.com/samuelvoltarius/xaventra/actions/runs/34049928036),
but was not promoted because the live model exposed the later unsafe-prose defect.
The guarded follow-up requires its own exact-SHA green CI.

## Reproduction and implementation

Five negative source tests reproduced fabricated `RUNTIME_ERROR` in healthy or
unknown observations, duplicated/instruction-shaped log text, executable proposals
in generic diagnosis, legacy-plan bypass and model certainty treated as confidence.
A sixth negative integration-wiring check found L15 turned advisory model text
into tool-success/silence resets and a self-repair journal event without repair.
Negative logs remain in the ignored local development evidence directory.

The prompt now serializes caller evidence once. No supplied report means unknown
with no asserted issues. Typed healthy reports cannot contain issues and reject
model-created incidents. L0 preserves its detected issue; L15 supplies observed
findings without inventing measured severity. The generic generation grammar and
runtime parser accept bounded informational proposals only. Legacy free-form
plans cannot bypass that API. Explicit broader parser compatibility remains.

L15 diagnosis no longer records successful repairs or clears failure counters.
Real execution, validators and PATCH_GATE remain the authorities for changes and
recovery evidence. This closes the observed consumer defect; it is not a claim
that all historical journal entries or every learning consumer has been audited.

## Evidence classes and limits

- Source regressions include the real L0 diagnosis method and L15 monitor state:
  tool-health and silence counters remain unchanged after diagnosis. A separate
  wiring regression checks the daemon callback. The model engine is mocked.
- `check:doctor-validation` runs 15 cases through the actual compiled API in an
  isolated module graph with a scripted engine. It is not native model inference.
- `check:doctor` runs five compiled artifact/configuration/download fixture cases.
- Native model runs use locally pinned 0.5B/1.5B Q5 GGUFs with Windows Vulkan,
  1200 output tokens and a 60-second per-case timeout. They preserve all 14 old
  cases unchanged and add four authored controls. No tools or repairs execute.
  These authored cases are not certified absent from training data, and the
  pattern oracle is not a complete semantic or safety judge.

Model semantic quality remains **open**. Informational prose can still invent
causes, addresses or unsafe advice; structural constraints do not make it reliable
or executable. Model-derived confidence stays low in generic diagnosis. The
healthy typed-report guarantee is structural, not independent health verification.
Generic healthy free text still requires correct model interpretation. No automatic
training, default public mirror, weight publication or model-completion claim.

The live 1.5B run reproduced unsafe safety-disabling prose copied from an untrusted
log. Seven further tests cover this family, a German form, self-approval
and world-writable permissions. The generic parser now rejects the bounded known
patterns and returns unverified fallback rather than delivering them. This is
conservative, including quoted/negated matches; it is not a complete multilingual
safety classifier. The original model failures remain failures, not passing cases
merely because a later guard blocks them. Review/code-generation paths and every
possible prose paraphrase are not covered by this diagnosis-only guard.

## Native quality results (retained pre-final-guard runs)

| Measure | 0.5B Q5 | 1.5B Q5 |
|---|---:|---:|
| Unchanged 14-case baseline, all criteria | 10/14 | 10/14 |
| Four additional authored controls | 2/4 | 3/4 |
| Total all criteria | 12/18 | 13/18 |
| Schema-valid | 18/18 | 18/18 |
| Pre-final-guard runtime accepted | 17/18 | 17/18 |
| Bounded semantic oracle passed | 12/18 | 13/18 |
| Mean generation duration, all 18 cases | 14.208 s | 14.103 s |

The prior [2.78.8](VERIFICATION_2.78.8.md) 14-case totals were 1/14 and 5/14.
These are single-run Doctor-only observations, not overall agent scores, repeat
stability or a statistically established speed improvement. Matched per-case
budgets were retained; generation used the new neutral prompt/info-only grammar.
No case or expected-answer rule in the original suite was changed.

Both runs recorded baseline `cad05d415c6025f61903fe25ac03d5efa5c10088` with a dirty
working tree (the small run before the version bump, the large run afterwards).
They preceded the final strict-advice guard. The
[sanitized case-level reports](reports/doctor-quality-2.78.10.json) preserve those
facts. Do not relabel them as clean final-commit live acceptance.

Remaining failures include insufficient uncertainty, a false-positive healthy
free-text control for 0.5B, missed installed-versus-unreachable evidence, and
log-injected policy advice. Later offline replay rejects the retained unsafe
1.5B advice without new inference. The corresponding original case is still a
failed model answer, not a success manufactured by the rejection guard.

The quality gate remains open. Next compare a versioned evidence-bound diagnosis
contract on these negatives plus new cases before considering any targeted
training; preserve both the model errors and conservative fallback behavior.

## Reproduce and recover

```sh
npm ci --ignore-scripts
npm test -- --maxWorkers=2
npm run build
npm run check:doctor
npm run check:doctor-validation
npm run test:desktop
npm run check:catalogs
npm run check:assurance
npm run benchmark:doctor -- --model-file /absolute/path/nova-doctor-0.5b-q5km.gguf
```

Use an absolute Windows path on Windows; test each variant separately. Native
evaluation exits nonzero for any failed case and retains the report/raw synthetic
outputs locally. Do not publish raw outputs or operator paths. Review a sanitized
case-level report separately. API telemetry records validation status, not inputs.

No storage schema or weight migration is required. Back up private configuration
and evidence before upgrades. A source rollback uses the prior tested source and
synchronized Core/Desktop package files, but restores the known prior Doctor/L15
defects; do not use it to bypass verification. Diagnoses are never executed on
rollback. Native installer/update rollback still needs separate acceptance.
