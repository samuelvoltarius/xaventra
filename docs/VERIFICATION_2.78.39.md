# Xaventra 2.78.39 verification

## Scope

This release candidate hardens the Telegram handover boundary. It does not
claim a physical-host failover, production rollout, live Telegram delivery or
general RC readiness.

## Reproduced defect

The daemon checked Main and Telegram leases around polling and the governed
reply path, but the adapter still exposed direct Bot API calls. Legacy command
handlers, progress, files, reactions and late chunks could therefore race a
leadership-loss callback and emit after the node stopped being authoritative.
Typing safety timeouts also survived normal completion and delayed disposable
process exit by 30 seconds.

## Change

- `TelegramAdapter` receives the runtime-owned authority verifier.
- All Bot API effects are wrapped at the SDK boundary and fail closed when
  either Main or Telegram authority is absent.
- Inbound message, voice, document, feedback and reaction paths check authority
  before their first effect or pipeline dispatch.
- Multi-chunk, fallback and streaming paths recheck between effects.
- Disconnect remains available without authority and clears both typing
  intervals and their safety timeouts.

## Evidence

| Evidence class | Result | Boundary |
|---|---|---|
| Focused source regression | 11/11 passed | Adapter effects, startup concurrency and polling retry guard |
| Compiled two-process handoff | 5/5 passed | Real Node process boundary with disposable file authority and fake Telegram transport |
| TypeScript/build | Passed | Windows local source |
| Full Core regression | 535 suites / 1,575 tests passed | Locked dependencies; per-process Git long-path support |
| Candidate CI | 10/10 jobs passed | Commit `be54bce6a9e340cc7087fe1ee5bf74e8550896c8`, run `35552924144` |
| Cross-platform handoff artifacts | 15/15 checks passed | Ubuntu, Windows and macOS each recorded the exact candidate revision and all five fencing checks |
| Public-history secret scan | Passed | Gitleaks 8.30.1 scanned 109 commits / about 10.90 MB with no findings |

The two-process acceptance checks:

1. the predecessor emits before takeover;
2. its adapter call is rejected after takeover;
3. a legacy direct Bot API call is also rejected;
4. its stale inbound update never reaches the pipeline; and
5. only the successor emits and consumes after epoch 2.

The first local full run is retained as negative evidence. A dependency junction
pointed at an older Sharp 0.35.3 tree instead of the locked 0.35.4 install, and a
nested Git fixture needed the supported per-process Windows long-path setting.
After exact `npm ci`, unchanged tests passed. Hosted CI must reproduce the clean
install without either local setup condition.

## Remaining gates

- Evidence and main exact-commit CI plus signed release publication.
- Physical-node/network-partition failover with real lease authority.
- Live Telegram polling/delivery continuity and durable pending-message replay.
- Signed production updater enrollment and broader install/update acceptance.
- Remaining RC gates in `docs/RELEASE_PLAN.md`.
