# Authenticated desktop capture and Telegram delivery

## Status and evidence

This guide describes the 2.78.57 source candidate, not a production-qualified
feature. Regressions cover the default policy denial, exact principal/channel
enrollment, trusted Telegram channel spelling and preserved failure details.
They do not prove that the deployed release contains these changes or that a
real user received a screenshot. Positive end-to-end Telegram acceptance remains
open; retain negative outcomes until the original request is independently met.

## Enrollment boundaries

Remote `desktop_*` calls are denied by default. A screenshot request does not
grant remote desktop-control authority. For a separately authorized capture
enrollment, use the existing operator `toolPolicy.rules` mechanism with exactly
`desktop_screenshot`, `channels: ["telegram"]` and the verified canonical
request principal in `users`. Never allow `desktop_*`, spoof CLI/Desktop, or
promote a guest. The independent authenticated-user role check still applies.

Before enabling that rule on Linux, install the reviewed capture agent in the
actual desktop session and configure Core's `NOVA_CAPTURE_SOCKET` and
`NOVA_CAPTURE_TOKEN_FILE` through the authorized deployment mechanism. The
daemon and desktop session may have different OS users; do not copy desktop
credentials into Core or change display ACLs. Endpoint permissions and the
authenticated bounded capture protocol must be verified independently.

The agent rejects locked or unknown session state. Only local user unlocking
can make a locked session available; do not disable the check or send a black
screen as successful acceptance. Missing enrollment is not permission to use
an alternative host or session.

Delivery uses the trusted execution context's Telegram principal, not tool
arguments or the last active chat. `Telegram` and `telegram` are equivalent
spellings of that same channel, not permission to cross channels. Capture and
delivery failures remain negative results. The message pipeline retains the
redacted capture-tool failure instead of hiding it behind a generic response.

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
