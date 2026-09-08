# Autonomous repair: executable path and acceptance boundary

## Implemented in the 2.78.13 source candidate

Self-Doctor snapshots create persistent research cases. The existing enabled,
Main-authorized autonomy cycle dispatches one eligible case through the normal
native agent and Execution Kernel. It does not create another tool executor,
require a Telegram recipient or impersonate a human owner. A unique contract
ID links tools, validation, the outcome and the persisted case.

The first executable stage is **diagnostic investigation**. Its model chooses
among scoped runtime-health, capability, mesh and tool-inventory observations.
It must return a report distinguishing observations, hypotheses, counterevidence
and a testable next step. Log/finding text is untrusted, secrets are redacted
before model input, and execution-protocol marker openers in findings are escaped.
The model is not supplied a repair lookup table keyed to each error.

Every tool still passes Kernel budgeting, authorization and lifecycle policy.
The Doctor gate also checks current authority and abort state. Introspection
is limited to `state`, `performance`, `tools`; user memories, prompts and goals
are not exposed. No shell, installs, source changes, configuration writes,
external messages or credential tools are permitted in this stage.

Each attempt has 90 seconds, six tool calls and a 6000-token contract budget.
The runner's cumulative token/cost accounting remains a separate release gap;
the token value is not advertised as a proven provider-side hard cap. Failed
attempts have a 15-minute backoff and stop after three attempts. Only one case
runs at a time in the coordinator. Its claim is saved before execution. A
nonterminal claim found after process restart is held for reconciliation, not
blindly replayed. A matching terminal outcome can be reconciled without a
second dispatch. Resolved/dismissed findings are not selected; a subsequently
observed recurrence can start a new investigation.

`investigation.status = verified` means **diagnostic execution evidence was
validated**, not that the hypothesis is correct or anything was repaired. The
case stays at `researching`. The old critical-finding path that treated more
than ten response characters as an executed action has been removed.

## What remains to complete the original promise

1. Scoped source/documentation research and typed, model-generated repair
   candidates, including evidence contradicting each hypothesis.
2. Automatic experiments inside a real isolated sandbox; build, regressions
   and rollback tests independently attached to that exact candidate hash.
3. Reversible activation only under an explicit operator autonomy policy;
   source patches and high-impact changes retain PATCH_GATE.
4. Re-run the original failed probe after activation. Only actual recovery may
   close the incident and qualify a learned repair workflow.
5. An independent supervisor for failure of the main process/model itself;
   multi-node ownership, partitions, stop/restart and exactly-once effects.

These stages are **not implemented by connecting the first stage**. Existing
AutoFix/self-evolution sandbox proposals remain separate, and their existence
is not counted as an end-to-end repair. Do not advance stage labels using model
prose or invent an approval/evidence reference to obtain a green status.

## Verification and operations

- `src/doctor/failure-research-worker.test.ts`: durable dispatch, evidence versus
  prose, retry limits, standby, concurrency, interrupted claims, resolved
  findings and execution-marker input controls. Worker receipts are fixtures.
- `src/doctor/research-worker.integration.test.ts`: actual native runner,
  authorization, Kernel, registry and ledger. Scripted model/fixture probe;
  includes authority loss and forbidden memory inspection.
- `scripts/check-doctor-research.mjs`: opt-in live local-model investigation of
  a disposable HTTP listener with a deliberately mismatched probe config. The
  model must identify the observed listener from actual probe tool evidence.
  It must leave the configuration untouched. This is diagnostic acceptance,
  **not** autonomous repair or a general agent benchmark.

For the optional probe, explicitly set `XAVENTRA_RESEARCH_QA_URL` to an authorized
OpenAI-compatible local endpoint and `XAVENTRA_RESEARCH_QA_MODEL` to its model,
then run `npm run build` and `node scripts/check-doctor-research.mjs`.
The child uses a temporary home/runtime with no inherited credentials, bot
tokens or production configuration. Reports include source revision, dirty
state, platform and failed checks. Never commit raw private investigation logs.

Installing this source does not authorize a production rollout. On an already
enabled autonomy runtime the existing cycle performs these read-only
investigations; disabled/standby runtimes do not. Stop autonomy before an
operational rollback. Preserve research and outcome files to reconcile pending
claims. Do not delete claims merely to force a retry while an old run may exist.
