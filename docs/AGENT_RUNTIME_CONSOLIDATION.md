# Agent runtime consolidation — local candidate, not deployed

The target is one Agents SDK continuation loop, with the Execution Kernel as
the only permission/completion authority. The channel runtime must retain
session isolation, memory/context preparation, model routing, policy hooks,
durable receipts, cancellation, typed failure escalation and output validation.

## Prepared locally

- One catalog intersection helper used by both existing adapters. Supplied
  catalogs can only narrow the contract; an empty contract exposes no tools.
- SDK model bridge preserves image inputs and correlated multi-call messages.
- Exactly one correction of an unexecuted out-of-catalog model proposal per
  model instance/run. The entire invalid batch is discarded before any effect;
  the offered catalog remains unchanged. Actual tool/permission failures are
  not covered by this correction and must retain their existing stop rules.
- Cancellation rejects late model output. The underlying legacy completion
  interface cannot cancel its HTTP request; this is not a transport-abort claim.
- A shared private-tracing SDK runner factory is available for integration.

## Staged migration evidence

After explicit approval, the existing authorization/idempotency/fencing executor
was extracted unchanged and its seven boundary tests passed. The native manual
continuation, discovery-retry and announcement-retry loops were then replaced
by the shared Agents SDK Runner. Each SDK call enters that same executor and
the existing correlated verification/receipt/typed-recovery path. Calls are
serialized; policy or unresolved execution failure prevents sibling dispatch.
Channel and subagent execution no longer select different loops through an
environment variable. The checkpoint-oriented SDK adapter remains for durable
approval/resume, using the same SDK Runner and Execution Kernel authority.

Six new actual-SDK tests cover out-of-catalog correction, correlated multi-turn
results, sibling cancellation on denial, repeated invalid batches, cancellation
and turn limits. One initially failed because structured SDK text output was
being serialized instead of unwrapped; the model bridge was corrected, keeping
the assertion. Full local Core regression passed 240 files / 1,687 tests.

An opt-in isolated compiled-runner acceptance used a real local Qwen model and
the operator-enrolled SearXNG service. With an old failure in conversation history,
the URL request executed one HTTP read, returned an actual source URL, passed
kernel validation, and retained that source in a follow-up with zero new effects.
The first acceptance attempt had an incorrectly constructed test contract and
failed with zero tools; its report was retained. Correcting the fixture to use
the real Execution Kernel yielded the successful result. This is not a Telegram
transport test or proof that production has this code installed.

The normal request-derived 15-tool catalog was also exercised with unrelated
effects blocked in the isolated fixture. This exposed and reproduced URL-check
intent and separately supplied GET-query target-binding gaps. Both are corrected
with positive and negative regressions; the final real run binds its successful
HTTP receipt to the requested URL plus query and retains the source on follow-up.
No shell example is executed while parsing those literal query fields.

## Earlier preparation evidence (historical)

Local preparation verification: targeted21/21, full Core239 files/1681 tests,
TypeScript typecheck and diff whitespace check passed. Initial Vitest startup
failed with cache EPERM; scoped test permission resolved it. An incorrectly
shaped new parameterized fixture failed twice; correcting its argument packing
preserved the assertions and both cases passed. No live model or Telegram
acceptance, release, commit, push or installation was performed for this change.

The original broad replacement was rejected before explicit staged migration
approval. The subsequent staged implementation above supersedes that local
source status, not the release or production-acceptance gates.

Remaining: publish with the existing release gates, install the verified artifact on
   the authorized Spark only, and verify actual Telegram inbound-to-answer
   behavior. Retain data and rollback artifacts; no other nodes are in scope.

Reference used for the runtime boundary:
[OpenAI Agents SDK running agents](https://developers.openai.com/api/docs/guides/agents/running-agents).
