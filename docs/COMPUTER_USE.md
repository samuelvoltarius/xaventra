# Screenshot and computer use on an enrolled Linux desktop

## Dedicated unattended workspace

`dist/host/workstation-main.js <runtime-directory> <state-directory> <token-file>`
creates its own Xvfb server with a fresh Xauthority cookie and TCP disabled.
Run it as a separate unprivileged user, with private persistent state and a
systemd-owned runtime directory. Dependencies are Xvfb, xauth, Openbox, xterm,
scrot and xdotool. It never attaches to an existing display or unlocks a personal
session. Screenshots and input address only the child display owned by this
process; loss of that display stops the adapter. This account is a separate
workspace, not a full VM/security boundary against all local kernel attacks.

### Startup guards (enforced by `workstation-main`)

The process refuses to start unless all of the following hold:

- `NOVA_WORKSTATION_ACCOUNT` is set in the unit to the dedicated account name
  and equals the running user; root is refused.
- The UID owns no graphical (`x11`/`wayland`/`mir`) logind session
  (`/run/systemd/sessions/*`) and the service did not inherit `DISPLAY` or
  `WAYLAND_DISPLAY`. Never run it as the personal desktop user.
- `<runtime-directory>` is owned by the account and is `0700`, or `0750` when
  the daemon reaches the socket through the group (no group write, no other
  bits). `<state-directory>` is owned by the account and `0700`.
- `<token-file>` is a regular file (not a symlink) owned by the account with
  no group/other bits (`0600`), and not inside the shell HOME.

Layout created by the process:

| Path | Mode | Content |
|---|---|---|
| `<runtime>/desktop.sock` | 0660 | daemon-facing socket |
| `<runtime>/private/` | 0700 | Xauthority and transient captures |
| `<state>/input-receipts/` | 0700 | durable input intents and receipts |
| `<state>/home/` | 0700 | HOME and cwd of openbox, xterm and xmessage |

The agent-controlled shell no longer has the state directory as HOME, so the
journal and token are not in its HOME. It still runs with the same UID; code
alone cannot stop a same-UID shell from reaching `<state>` by absolute path.
Full isolation requires a deployment change: run the X children (openbox,
xterm) as a second unprivileged account without access to `<state>` and the
token, or remove the interactive shell. Until then treat journal integrity as
best effort against the agent's own shell.

Upgrading an existing installation: dotfiles that lived directly in `<state>`
(for example `.bash_history`, `.config/`) stay there and should be moved into
`<state>/home` or removed. `<runtime>/private` must not exist before start;
a systemd `RuntimeDirectory=` is cleaned automatically.

Use a private Unix socket and explicit daemon group access as below. The daemon
must load the operator tool policy at startup, and the input tool must be present
in its installed build. Running the workstation alone does not add tools to an
older daemon. A real workstation acceptance has confirmed capture, click/key
effects with changed image bytes, and duplicate suppression; Telegram delivery
remains a separate acceptance.

The agent has two separate tools: `desktop_screenshot` captures and, when
requested, sends an image to the authenticated Telegram requester;
`desktop_input` moves/clicks the mouse, types text, presses keys and scrolls.
Input success means the input helper completed, not that the intended UI outcome
was achieved. Inspect a fresh screenshot after an action. Never blindly repeat
an uncertain click or keystroke.

## Explicit deployment prerequisites

This integration currently targets a GNOME X11 desktop session. It does not
unlock sessions and does not grant access to another display automatically.
The session needs `gdbus`, `gnome-screenshot` and `/usr/bin/xdotool`. Wayland input
is not implemented by this adapter and must not be advertised as supported.

Run the existing `dist/host/capture-agent-main.js` as the intended desktop user
with the session's own DISPLAY and session bus. Its arguments are the enrolled
local Unix socket and a private token file. The socket is mode 0660; its group
must be explicitly shared with the daemon. Token files must be private (0600),
with separate same-value copies for the session user and daemon if necessary.
Do not use `xhost +`, expose the adapter on TCP, or forward display credentials
to the model. An existing socket is not automatically removed.

Set `NOVA_DESKTOP_INPUT_JOURNAL` in the **session agent** to an absolute private,
persistent directory to opt into input. Without it, that agent remains
capture-only. Preserve this journal across restarts: a recorded intent without a
completed receipt is uncertain and may not be repeated automatically.

Set these operator-owned variables in the **daemon**:

- `NOVA_CAPTURE_SOCKET`: that local socket.
- `NOVA_CAPTURE_TOKEN_FILE`: daemon-readable private token file.
- `NOVA_DESKTOP_TELEGRAM_OWNER_ID`: the exact authenticated Telegram user ID.
- `NOVA_DESKTOP_INPUT_ENABLED=1`: opt into input separately from screenshots.

These settings grant only the two named tools to that Telegram identity;
existing explicit policy denials/confirmation rules still take precedence,
and normal user-role authorization remains mandatory. Other desktop tools,
users and remote channels receive no new grant. Do not use model-provided IDs.

All `desktop_*` tools are denied by default on every channel, including CLI,
web, API and REST, for owners and admins alike. Grants exist only through:
the enrolled Telegram owner above; the authenticated Nova Desktop client
context on the `desktop` channel for its own client-side tools
(`desktop_workspace`, `desktop_control`, `desktop_status`, `desktop_screenshot`,
never `desktop_input`); or an explicit operator `allow` rule in `toolPolicy`.

`desktop_screenshot` also checks the rule inside its handler (owner ID,
Telegram channel, run id), so a caller that skips the governed executor
cannot capture. When `NOVA_CAPTURE_SOCKET` or `NOVA_CAPTURE_TOKEN_FILE` is set
it captures only through the enrolled adapter and never falls back to the
daemon's local display; without an enrolled adapter it refuses and captures
nothing. `send_file` delivers only to the authenticated
Telegram requester of the current run; it ignores `chat_id` and never uses the
last active chat.

`desktop_input` refuses session-critical keys (`ctrl+alt+Delete`,
`ctrl+alt+BackSpace`, `super+l`, `ctrl+alt+F1`..`F12`); `alt+F4` is allowed.
Its idempotency scope is the server-side run: a `[NOVA_MISSION_KEY:...]` in
the request is accepted only with the live mission fencing token. A repeated
step returns `status: "replayed"`, `executedNow: false`; no new input ran.

## Acceptance and limits

First verify that a locked session returns a lock error without a capture or
input. Once the user locally unlocks the intended session, request a screenshot
through Telegram and verify actual image arrival. Test input in a disposable
editor/window, then inspect the resulting screenshot. Keep capture, delivery,
input and visual outcome as separate results.

Current source tests cover exact-user/channel policy, authentication, typed
argv-only commands, receipt correlation, persisted duplicate suppression and
uncertain-effect refusal. They do not establish live desktop or Telegram
acceptance. This source change is not automatically installed in an existing
production daemon; both daemon and session agent need the reviewed build and
explicit enrollment above.
