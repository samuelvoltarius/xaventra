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

The first exact-source CI candidate, `90b37c7ca4caab2fa002458a4805934414cb3306`,
is retained as a failed gate in
[CI 35458289978](https://github.com/samuelvoltarius/xaventra/actions/runs/35458289978).
Its Windows fixture had passed locally, but the three hosted operating systems
showed that a command containing explicit absolute Unix paths without the nouns
“file” or “Datei” was classified as a generic action. It therefore had no bound
file targets and incorrectly accepted the first read. The follow-up recognizes
an explicit machine-comparable path after a read/open/compare verb on every
platform and adds both Unix and Windows regression forms.

The first follow-up, `6f1356686cb3ba581092af27176083c6b59e82e1`, also
failed closed in
[CI 35459169546](https://github.com/samuelvoltarius/xaventra/actions/runs/35459169546).
Intent classification was then correct, but the unquoted file matcher allowed
spaces and greedily joined `/a.txt und /b.txt` into an invented combined target.
The corrected parser stops unquoted targets at whitespace, handles quoted paths
with spaces separately, and removes suffix duplicates. Its regression asserts
the exact two Unix targets and one quoted Windows target.

That CI also retained a separate legacy-dashboard audit failure. `npm ci`
succeeded, but npm's retired quick-tree audit endpoint rejected the valid
installed graph before returning advisory data. CI now audits the lock graph
that `npm ci` just installed (`--package-lock-only`); it still fails on high
severity advisories and does not turn registry unavailability into success.

The first repeated local full-suite run after the follow-up retained one
environmental failure: the deeply nested disposable repair-publication Git
repository exceeded Windows' default path handling and `git status` could not
read its loose objects. The same unchanged suite with process-local
`core.longpaths=true` passed **224 files / 1,540 tests**. This setting changes
only Git path handling for the test process; it does not skip or weaken a test.

## Open gates

- Exact clean-source three-platform CI for the follow-up and final evidence commit.
- Typed semantic targets beyond explicit files/URLs.
- Evidence rehydration across every native/distributed interruption boundary.
- Expected missing-file recovery without unnecessary retries.
- Production Telegram/Desktop adoption and complete RC/HA acceptance.
