# 2.78.8 — Doctor output validation and separate model-quality evaluation

This bounded source change is **not RC acceptance**, model retraining or a
production rollout. Existing Doctor artifact delivery remains separate from
diagnosis quality. No weights, operator configuration or raw output are included.

Guarded runtime commit `1cccf74860996f092be7341ff0dcee8e76808409` passed all
seven jobs in [candidate CI 34040574609](https://github.com/samuelvoltarius/xaventra/actions/runs/34040574609).
Downloaded reports identify that exact clean SHA, version 2.78.8 and 9/9 compiled
Doctor API plus 5/5 artifact cases on Windows, Linux and macOS. The same run
passes all 1191 Core regressions, lifecycle/response and packaged Desktop jobs.
Their hosted providers are scripted; this is not native Doctor model quality.
The initial pre-credential-guard commit `bfc38b1ae96896269a1afaa073288430af7eddd0`
also passed [its CI](https://github.com/samuelvoltarius/xaventra/actions/runs/34040338014),
but it does not establish the later guard. Any documentation-only attestation
must pass its own exact-SHA CI before main promotion.

## Reproduced failures and changes

Three regression cases failed against the previous wrapper: `{}` was accepted
as a clean review, `{}` became an empty fix, and model initialization rejection
escaped diagnosis instead of returning an explicit unverified result. The
original failing local log is retained, not replaced by the passing rerun.

Complete typed review/fix contracts now reject these outputs, wrong-type fields,
reasoning-wrapped JSON, whitespace-only code and contradictory clean findings.
Valid review findings remain advisory (`verified: false`); valid proposed code
is retained but `safe` is always false. Initialization failures in all three APIs
are caught. No model text can authorize repair or replace tests/PATCH_GATE.
Telemetry no longer stores raw error prefixes, and labels schema validation
separately from semantic correctness.

The 1.5B live comparison additionally answered a filesystem permission failure
with a request for an invented API key/service. Two new negative parser cases
confirmed this passed through both suggestion categories. Generic diagnosis now
rejects structured `ask_secret` requests; credential entry belongs to validated
setup with a trusted channel. A wrapper regression confirms no such request is
delivered. This bounded typed rejection is not a general prose/link safety filter.

## Source and compiled API acceptance

The new 19-case wrapper suite, two credential-parser cases and four independent
oracle tests are isolated from production files and native inference. The compiled API harness has nine
cases using the actual built client/contract and a scripted engine. Hosted CI
executes this harness on Windows, Linux and macOS and preserves its reports even
on failure. This is source/API evidence, not a live-model score.

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run check:doctor
npm run check:doctor-validation
npm run test:desktop
```

Candidate exact-SHA CI and report readback are required before main promotion.
Any later documentation-only attestation also needs its own exact-SHA green CI.
Local Windows verification before the credential guard passed **180 files / 1188 Core tests**, seven Desktop
bridge tests, build/typecheck, catalogs and the assurance gate. The built Doctor
artifact fixture passed 5/5 and the separate scripted API harness passed 8/8.
After the credential guard, the full suite passed **180 files / 1191 tests**,
build/typecheck and all nine compiled API cases. The hosted exact-SHA evidence
above is separate from these local checks and from native model evaluation.

## Actual GGUF evaluation: negative evidence is retained

The separate runner sends 14 authored synthetic inputs through the actual local
engine and the runtime diagnosis prompt/grammar, then uses a bounded independent
pattern oracle and the production parser. Expected labels are not sent to the
model. Cases include refused connection versus bind conflict, missing modules,
permissions, unknown causes, two healthy controls and untrusted log directives.
No tool is executed and fallback does not count as successful model generation.

Both variants use the same 1200-token / 60-second per-case budget, temperature
0.05 and local Windows Vulkan backend. These are single runs, not statistically
repeated estimates or general semantic accuracy. Pattern matches can miss other
errors; all outputs remain advisory. The cases were newly authored here, but no
independent training-data audit establishes a certified held-out dataset.

The 0.5B Q5_K_M run produced valid-schema JSON in 14/14 cases; only 3/14 passed
the production parser, 9/14 passed the limited oracle and **1/14 passed all three**.
Mean generation/validation time was 20.745 seconds. For example, it invented a
configuration key to install a missing package and confused an unreachable
listener with an unavailable port. Those suggestions are not executed.

The 1.5B Q5_K_M run passed the schema in 13/14 cases, the pre-credential-guard
runtime parser in 9/14 and the limited oracle in 7/14; **5/14 passed all three**.
Mean time was 25.350 seconds, including a 60-second failed generation. It also
invented an API-key requirement for a filesystem error and assigned a runtime
root cause to healthy controls. Larger weights are not a repair-safety guarantee.

The [sanitized case-level report](reports/doctor-quality-2.78.8.json) retains both
negative runs, separate criteria and pinned model hashes, without raw outputs or
operator data. These runs preceded the credential guard, so their parser counts
must not be presented as measurements of that later guard.

This working-tree evaluation was started from base commit
`960ba4ae9d356d50cd4598d77289392a4a00e416`, before the version bump; reports
truthfully record `sourceDirty: true` and package version 2.78.7. It is negative
development evidence, not exact-final-commit release acceptance. Native model
evaluation is local only, not part of the hosted fixture CI.

## Open gates and recovery

- Doctor model quality is **open**. Correct JSON and verified downloads do not
  establish useful diagnosis, repair safety or the need for retraining. Next,
  investigate prompt/report grounding and unsupported configuration proposals;
  compare any change on unchanged cases plus new unseen cases. Do not relax the
  parser, discard failures or label fallback as model success to improve scores.
- Full six-variant quality comparison, native code-review/fix-generation quality,
  repeated runs and provenance/training-data review remain open.
- No public default mirror is added here. Existing explicitly configured mirrors
  remain supported; source/distribution decisions are separate from local tests.
- Native installer/signature/upgrade/rollback, channel handover, distributed HA
  and the other [RC gates](RELEASE_PLAN.md) remain open.

See [Doctor installation and test commands](DOCTOR_MODELS.md). Keep private config
and known-good artifacts; an application rollback uses a previously verified
source version. It must not bypass hash checks or grant model-issued approval.
