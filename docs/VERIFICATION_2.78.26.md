# Xaventra 2.78.26 verification

## Scope

This bounded candidate corrects action/target-specific completion evidence. It
does not claim all tool calls, memory, Mesh failover, self-repair or RC readiness.
Production nodes were not changed.

## Negative-first reproduction

Before this change the Kernel retained only a set of successful tool names. One
successful `read_file` could therefore satisfy “read `a.txt` and `b.txt`”; the
validator could not prove which model call or arguments produced the result.

The new regression requires two explicit targets. An unrelated successful health
check and the first successful file read both leave completion false. Reusing the
first call ID for the second file is rejected. Only a distinct verified receipt
whose arguments cover `b.txt` completes the task. A successful result without an
execution correlation is also rejected.

## Local evidence before candidate commit

- TypeScript typecheck: passed.
- Full Core regression: **224 files / 1,539 tests**, passed.
- Targeted Kernel/TaskContract/tool-message/OpenAI-backend tests: **22/22**, passed.
- Compiled native runner: **7/7**, real disposable filesystem, scripted HTTP
  provider, actual policy/Outcome Ledger/validator. The partial-two-file negative
  case passed only because final task validation failed for the missing `b.txt`.
- Live local Qwen on Spark: **2/2**, disposable files only. Single read:
  **7,996ms / 2,299 tokens / 2 calls**. Two-file read:
  **11,057ms / 2,533 tokens / 2 calls**.

The first targeted run retained two test-assumption failures: the sentence lacked
the noun that intentionally triggers file intent, and an assertion expected a
provider call ID to change across rounds. The corrected tests preserve the Runtime
behavior: explicit file intent and stable provider correlation. No production
assertion was removed or weakened.

The first full regression then exposed one real integration defect: the isolated
benchmark probe reduced its evidence to a successful tool name and operated on a
different sandbox file than the contract named. The probe now admits its typed
executor in the contract, operates on the exact fixture target and forwards call
ID, arguments/result hashes and matched targets. The repeated full suite passes;
the failed run is retained in the private test log.

## Open gates

- Exact clean-source three-platform CI and final evidence commit.
- Typed semantic targets beyond explicit files/URLs.
- Evidence rehydration across every native/distributed interruption boundary.
- Expected missing-file recovery without unnecessary retries.
- Production Telegram/Desktop adoption and complete RC/HA acceptance.
