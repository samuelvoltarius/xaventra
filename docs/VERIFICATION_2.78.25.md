# 2.78.25 — bounded native tool-budget correction

Base: `e601d2c5cd053b68b97f710c0e1015ec4ece2946`. Candidate evidence below is
working-tree evidence until bound to its exact pushed runtime revision and CI.
No production deployment, full tool acceptance or RC qualification.

## Reproduction

Two new regressions failed before implementation: prompt 5,333 + output 47 was
compared to a 1,024 answer allowance, rejecting a verified read; a distinct output
limit was not enforced. Follow-up usage was omitted from native ledger totals.
Both source regressions pass after separating the fields and cumulative accounting.

## Checks and retained limits

- Windows compiled native runner/real filesystem/scripted HTTP: initial 4/4
  (read, chained reads, zero total limit, oversized provider response). Expanded
  final six-case suite **6/6** at 15:08 UTC also covers exhaustion/oversized response
  after a valid read. Exact three-platform CI remains required before promotion.
- Windows native runner with actual local Qwen: 2/2 at 2026-09-19 15:02 UTC,
  read 9,709ms / 2 calls / 2,317 tokens; two files 11,239ms / 2 calls / 2,530 tokens.
  Fresh canaries were absent from the initial prompt. Both final answers and real
  tool evidence passed. The model selected both reads together in the second live
  case; the scripted case separately forces a three-inference chained path.
- Live run is isolated native execution from Windows, not the deployed Telegram
  process, packaged CLI/Desktop, Mesh discovery or distributed failover.
- Initial full regression: 1,529/1,531. One Windows long Git path failure and one
  Doctor budget failure retained. Enable Git `core.longpaths` for this deeply
  nested test workspace. Doctor contracts use generation allowances and scripted
  usage is explicit; boundary tests additionally assert they reach the model.
  No assertion was removed to produce a green score.
- Windows final combined regression: **224 files / 1,533 tests**, including
  cloud forwarding checks against mocked HTTP (no cloud API calls).
  Desktop bridge **7/7** and compiled native/REST response
  contract **5/5** pass. An attempted compiled catalog generator command failed
  (dev-only script is not emitted); the documented tsx generator succeeded.
- Build, catalog freshness and Assurance: **passed**. The initial Assurance run
  lacked a config; rerun used only the public example, never production config.
  Redacted staged-diff and 71-commit public-history secret scans: **no findings**.
- Exact candidate CI must be recorded before promotion. Native signatures,
  complete memory correction, action/target-specific validation, general missing-
  file recovery and all previous HA/RC gates remain open.

## Exact runtime follow-up

Runtime source `f752484977a5e1dac3f860335e956388e57a972d` passed the live native
Qwen pair again (7,463ms / 2,276 tokens; 10,486ms / 2,521 tokens) and an actual
interactive Windows `cli chat` read through the full message pipeline, with
isolated config/memory, an unknown file canary and normal `/exit` (exit 0).
The first private CLI parser included asynchronous diagnostic logs in the reply;
that negative report is retained. The repeated test checks the CLI's actual reply
framing and exact canary, not merely a token somewhere in the transcript.

[Initial candidate CI 35451158383](https://github.com/samuelvoltarius/xaventra/actions/runs/35451158383)
exposed a scripted Doctor fixture with missing usage. The new budget conservatively
reserved its whole generation allowance, correctly refusing a continuation.
The fixture now declares synthetic usage (as the unit fixture does); real-model
responses and production handling are unchanged. All Docker assertions remain.
The final candidate requires fresh complete CI; this failed predecessor is not a pass.

See [budget semantics and recovery](TOOL_BUDGETS.md). Inference inside remote or
provider-owned sub-runs is not independently counted by this native wrapper.
