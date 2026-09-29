# Authenticated desktop capture and Telegram delivery

## Status and evidence

This guide describes the 2.78.57 source candidate, not a production-qualified
feature. Regressions cover the default policy denial, exact principal/channel
enrollment, trusted Telegram channel spelling and preserved failure details.
They do not prove that the deployed release contains these changes or that a
real user received a screenshot. Positive end-to-end Telegram acceptance remains
open; retain negative outcomes until the original request is independently met.

## Policy: default deny, three allow paths

All `desktop_*` tools are denied by default on every channel, including CLI,
web, API and REST, and for owners and admins alike. A screenshot request does
not grant remote desktop-control authority. Only these three paths allow a
desktop tool; existing explicit denials and confirmation rules still take
precedence, and the independent authenticated-user role check always applies:

1. **Enrolled Telegram owner.** With `NOVA_DESKTOP_TELEGRAM_OWNER_ID` (the
   exact numeric authenticated Telegram user ID), `NOVA_CAPTURE_SOCKET` and
   `NOVA_CAPTURE_TOKEN_FILE` set in the daemon, that identity may use
   `desktop_screenshot` on the `telegram` channel; `desktop_input` needs
   `NOVA_DESKTOP_INPUT_ENABLED=1` in addition.
2. **Authenticated Nova Desktop client.** On the `desktop` channel, inside the
   client context set by the desktop API after client authentication, the
   client's own tools `desktop_workspace`, `desktop_control`, `desktop_status`
   and `desktop_screenshot` are allowed. Never `desktop_input`.
3. **Explicit operator rule.** An operator `toolPolicy.rules` entry with
   `action: "allow"`, naming the exact tool (for example only
   `desktop_screenshot`), the channel and the verified canonical principal in
   `users`. Never allow `desktop_*`, spoof CLI/Desktop, or promote a guest.

`desktop_screenshot` also checks the owner/principal/channel/run rule inside
its handler, so a caller that skips the governed executor cannot capture. The
legacy tool registry (`cli.ts`, `llm/base.ts`, `tools/executor.ts`) delegates to
the same hardened tool, drops model-supplied `chat_id`, and refuses unless an
authenticated desktop client or an enrolled capture adapter is configured; it
never captures the daemon's local display. When `NOVA_CAPTURE_SOCKET` or
`NOVA_CAPTURE_TOKEN_FILE` is set, capture goes only through the enrolled
adapter, without local-display fallback on denial, lock, timeout or
misconfiguration. Without an enrolled adapter the handler refuses with
`no enrolled capture adapter; local capture disabled` (also for the owner and
for an operator allow rule); only the authenticated Nova Desktop client path
captures without Core-side enrollment.

## Enrollment boundaries

Before enabling path 1 or 3 on Linux, install the reviewed capture agent in the
actual desktop session and configure Core's `NOVA_CAPTURE_SOCKET` and
`NOVA_CAPTURE_TOKEN_FILE` through the authorized deployment mechanism. The
daemon and desktop session may have different OS users; do not copy desktop
credentials into Core or change display ACLs. Endpoint permissions and the
authenticated bounded capture protocol must be verified independently.

The agent rejects locked or unknown session state. Only local user unlocking
can make a locked session available; do not disable the check or send a black
screen as successful acceptance. Missing enrollment is not permission to use
an alternative host or session.

## Delivery

Delivery uses the trusted execution context's Telegram principal (channel
`telegram`, numeric authenticated user ID), never tool arguments (`chat_id`)
and never the last active chat. The same rule applies to `send_file` and to
images from `generate_image`; without an authenticated Telegram requester
nothing is sent and the tool reports the saved file path. `Telegram` and
`telegram` are equivalent spellings of that same channel, not permission to
cross channels. Capture and delivery failures remain negative results. The
message pipeline retains the redacted capture-tool failure instead of hiding
it behind a generic response.

## Idempotency and replays

A result served from the idempotency cache is marked `replayed: true,
executedNow: false` (non-object results are wrapped as `{ result, replayed,
executedNow }`); it is not a fresh capture, send or input. A
`[NOVA_MISSION_KEY:...]` in request text becomes the idempotency scope only
with a valid mission fence of the same mission; a user-typed key is ignored
(and refused by `desktop_input`).

## Acceptance and failure diagnosis

Use the failed request's run/trace correlation to distinguish authorization
denial, capture-agent enrollment failure, a locked/unavailable session, invalid
image evidence and delivery failure. A denial before capture is not evidence of
a failed screenshot executable or Telegram upload. Keep public reports redacted;
do not publish identities, tokens, desktop images or private logs.

Acceptance requires a real user request through Telegram, correlated capture
and delivery receipts, and confirmation that the received image is the intended
unlocked desktop. Mocked tests, an adapter connection, or a manually sent image
do not satisfy this check. Publishing and activating the reviewed code remain
separate steps governed by the signed release/update process.
