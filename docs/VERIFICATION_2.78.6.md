# 2.78.6 — current-turn response contracts

Status: bounded source reliability step, **not RC-ready**. No production
deployment, signed binary or installer publication is part of this round.

## Reproduction and fix

The retained 2.78.5 real-provider native/REST run passed 7/8: the model remembered
the new identifier but repeated the rejected old identifier despite an only-new
instruction. The kernel approved it using only `response-present`. An independent
regression reproduced that false validation with different identifiers.

`response-contract.ts` derives exact-text constraints from explicit current-user
instructions, not history, tool output or retrieved documents. It supports
quoted literal replies and one explicitly declared current/new field in bounded
German/English forms. Ambiguous references, multiple declarations, quoted
blocks, secrets and unsupported grammar are not guessed. This is not universal
natural-language schema inference.

The TaskContract owns the rule. The model sees it before answering; independent
completion validation enforces it. A conversational format failure may receive
one text-only repair: zero tools, at most eight seconds within the task deadline,
remaining token budget, no repair of policy-denied/awaiting-approval/action tasks.
A configured USD cap disables the extra call until reliable pre-call costing is
available. Initial failure and final validation remain in the same Outcome.
Persistent failure is not marked complete or delivered as successful output.

Adversarial acceptance also exposed discarded local usage and ineffective
output-hook handling. Local OpenAI-compatible/Ollama usage now survives the
adapter; repair usage is included. Hooks run before final validation/persistence.
The channel pipeline preserves validated literals, suppresses optional footers
and invalidates a run if delivery sanitization breaks its constraint.
Model prose containing `/mission` cannot start work after validation; the actual
user command and typed, governed mission tool remain available.

## Evidence inventory

- Windows local regression: 175 files / 1132 tests, seven Desktop bridge tests.
  Build, typecheck, catalogs and assurance are required release gates.
- `npm run check:response-contract`: five compiled native-runner/authenticated
  REST cases and four actual Desktop API/message-pipeline cases. Scripted local
  provider, isolated profiles, no private configuration or credentials. Tests
  cover retained failed validation, one repair, repeated failure, short literal,
  post-hook mutation/denial, exact output with verbose enabled, and mission prose.
  These are not nine autonomous real-model tasks or a packaged UI signoff.
- Separate Windows live local-provider run: original eight native/REST cases
  passed without changing expected values/exclusions. Real file reads,
  correction, fresh-process recall and other-user isolation are covered. No
  live Telegram, full daemon or distributed HA claim follows from this score.
- Candidate CI repeats Core, compiled lifecycle, response-contract and packaged
  Desktop checks on Windows/Linux/macOS at the exact candidate SHA. Retained JSON
  reports identify version, platform and source revision. Inspect all seven jobs
  before main promotion; a preceding SHA is not sufficient.

Negative evidence remains private and is not deleted or relabeled: the original
7/8, pre-fix validator regression, and compiled failures for missing usage and
post-hook mutation. Raw transcripts/local paths are not copied into public source.

## Remaining RC boundaries

General unstructured output instructions and ambiguous references still depend
on planning/model behavior. Local non-streaming token usage now propagates, but
complete cumulative accounting across every tool round, streaming provider and
fallback/inference host remains open. Unconfigured local energy/hardware prices
are not evidence of zero real cost.

Native dialogs/capture/keychain and install/update/rollback, isolated channel
delivery, distributed mission takeover/fencing/memory convergence, and required
signatures/notarization remain open. See the [RC inventory](RELEASE_PLAN.md).

## Reproduce and upgrade

```sh
npm ci --ignore-scripts
npm run build
npm test -- --maxWorkers=2
npm run check:response-contract
```

For `npm run benchmark:acceptance`, use an explicitly configured disposable local
endpoint. Scripted checks need no provider credentials. Workers inherit only
required OS environment entries. No production configuration or memory format
migration is required. Back up runtime data before an operational upgrade and
run local acceptance first. A source rollback preserves the old memory format
but restores the previous response-validation defect; it is not a native
installer/update rollback proof.
