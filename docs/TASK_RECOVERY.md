# Bounded task recovery

## Current candidate

These are 2.78.57 source-candidate contracts, not claims of production activation
or completed Telegram acceptance. See [screenshot delivery](SCREENSHOT_DELIVERY.md)
and [native update integration](NATIVE_UPDATE_DRIVER.md) for their separate gates.

An exact single-URL GET check selects `fetch_url`, not a search about the URL.
Mixed instructions and unsupported request flags retain normal planning. The
target validator still requires a correlated result covering the requested URL.
A successful search for the same words is not equivalent evidence.

`load_skill_pack` is a catalog lookup, not runtime permission expansion. The
reviewed `web` alias resolves to `web-search`; unknown names still fail. The
running tool contract remains immutable. A catalog lookup is not task completion.

Uncertain `workflow:* / route-success` beliefs remain stored for diagnosis but
do not ask users to resolve internal route reliability before a new observation.
Actual factual conflicts, principal isolation and ambiguous risky targets remain
gated. A resolved screenshot target may proceed to normal tool authorization;
remote requests still require exact operator-enrolled principal/channel/tool
policy. Target resolution does not prove that a display is accessible or an
image was delivered.

## Self-healing design: reuse the existing authority

1. Preserve the original requested outcome, principal, contract, failed call and
   receipts. Diagnose a typed failure; do not infer a cause from a later success.
2. For an already approved, bounded recovery class, perform only its permitted
   correction or retry. Unknown effect outcomes require receipt reconciliation,
   never blind re-execution. Policy denials are not permission to try another
   identity, channel or executor.
3. Validate the original outcome, including every target and required delivery.
   A successful diagnosis or loaded catalog does not satisfy it.
4. If unresolved, use the persisted Doctor queue and existing research budget.
   Unknown code changes become proposals, not autonomous live edits.
5. Use the existing isolated baseline/candidate regression and rollback tests,
   then PATCH_GATE and an enrolled signed update controller. Independently
   re-test the original symptom after activation; retain failures and rollback
   when the verified activation contract requires it.
6. Learn a reusable recovery only from independently verified success. Scope
   learned observations by user and capability; do not turn failures into
   universal clarification blockers.

This describes the intended closed loop, not a claim that every production
adapter is enrolled or every fault heals itself. Missing display access needs an
authenticated capture adapter; missing disk capacity needs an authorized storage
plan. Neither permits weakening access controls or deleting audit evidence.

## Evidence boundaries

### Native GNOME capture adapter (candidate)

`dist/host/capture-agent-main.js <socket> <token-file>` runs as the logged-in
desktop user, with that session's display environment. The operator must enroll
a private Unix socket directory, a strong private token and explicitly restricted
socket group. The daemon uses `NOVA_CAPTURE_SOCKET` and
`NOVA_CAPTURE_TOKEN_FILE`; its token copy must be mode0600. Do not grant general
X11 access, remove service hardening, or run the daemon as the desktop user.

The adapter accepts only an authenticated fixed capture operation and request ID,
checks GNOME lock state, invokes a fixed `gnome-screenshot` executable, bounds
duration/size/concurrency and returns request-correlated SHA256 evidence. It never
unlocks the desktop. An existing socket is not replaced automatically; stale
socket recovery needs operator reconciliation. There is no shell or arbitrary
file-read endpoint. Temporary capture data is removed by the adapter; audit data
is untouched. Locked or unavailable sessions fail closed without another capture
path. This adapter currently targets Linux GNOME, not all advertised desktops.

Native screenshot delivery is bound to the authenticated Telegram sender, not
the globally last-active chat or model-supplied chat ID. Capture-only results do
not claim delivery; requested delivery failures prevent task success.

Run `node scripts/check-telegram-task-routing.mjs` with an explicitly configured
`XAVENTRA_QA_MODEL_URL` after building. It uses actual model inference, the SDK
loop and ExecutionKernel, with a controlled single-target HTTP executor. It
does not test production role authorization, a real search backend, screenshot
capture/delivery, installed release state or Telegram acceptance. Its report
is retained in a fresh temporary directory, including on failure.
