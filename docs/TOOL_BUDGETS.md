# Native tool-call budgets and recovery

`TaskBudget.maxOutputTokens` is the cumulative generated-token allowance for one
native run, including planning, tool follow-ups, recovery and formatting repair.
The existing adaptive amounts are unchanged (ordinary fast mode: 1,024), but are
now shared across rounds rather than sent independently only on the first call.
Input prompt tokens are recorded separately; they are not response tokens.

`TaskBudget.maxTokens` remains an optional cumulative input + output ceiling.
Explicit external contracts and persisted contracts retain that meaning. Zero
forbids model inference. A textual request/schema UTF-8 bound plus framing is
reserved before dispatch; insufficient reservation refuses the call. This can
conservatively reject a request that a provider tokenizer would fit. Do not
silently increase the ceiling or reinterpret external/persisted contracts.
New built-in adaptive and Doctor contracts set the generated-token field; any
existing custom contract must be reviewed by its operator if it meant output only.

The Kernel owns the run-local accounting. No global client is modified. Native
follow-up, planner retry and repair clients share that account. Provider-reported
usage replaces reservations; omitted/malformed usage and failed/pending calls
retain reserved estimates. Ledger cost records label estimates. A provider that
returns more output than admitted cannot authorize a tool from that response.
An exhausted/uncertain continuation remains failed even if an earlier read worked.
Already executed tools are not automatically repeated or declared undone.

This boundary observes native `complete()` calls, not every hidden provider-side
retry, remote Codex sub-run or SDK-internal action. Existing provider failover
settings are preserved, not silently disabled. Hard cancellation inside every provider, exact remote billing,
multimodal token accounting and cross-provider cost attribution remain separate
work. A conservative reservation is not an exact tokenizer measurement.

## Verify

```sh
npm ci
npm run build
node scripts/check-tool-budget.mjs
node scripts/check-tool-budget.mjs --live http://YOUR-LOCAL-MODEL:8000 MODEL_ID
```

The default suite uses scripted HTTP responses but real compiled native execution,
typed `read_file`, policy, independent validation and a disposable Outcome Ledger.
The live variant sends only disposable file tasks to the explicitly named local
model. It does not use production configuration or credentials. Final user output
must contain the unknown file identifiers; debug/tool output alone never passes.
Set `XAVENTRA_TOOL_BUDGET_QA_DIR` to retain reports in a chosen private directory.

Rollback: stop the candidate normally and select the previous verified artifact;
this change has no state migration. Do not roll back by mutating a live checkout.
Old contracts keep their fields, so a restart does not reset a contract's semantics.
Resuming inference-budget counters across interrupted native missions remains an
open gate; this run-local change does not claim durable distributed resume.
