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

## Computer use on a mesh node (own lab computer)

Main can operate the dedicated workstation of an enrolled mesh node, for
example a lab VM, without a desktop of its own:

- `mesh_screenshot` captures the node's workstation (unchanged).
- `mesh_desktop_input` sends one typed action — `move`, `click`, `type`,
  `key`, `scroll` or `open_url` — over the signed `capture.request` envelope
  (`operation: "input"`), fenced by Main authority like a capture. The node
  answers with the input receipt **and a fresh capture**. The tool stores that
  image privately and returns its path; whether the action had the intended
  effect is judged only from that capture (`analyze_image`), never from the
  input receipt. Pixels never enter model text, queues or caches.
- The node journal key is derived from run, owner, node and step. Repeating
  the same step returns `status: "replayed"`, `executedNow: false`; an
  uncertain earlier effect is refused, never repeated.

Switches and opt-ins, all operator-owned:

- Main: on by default since 2.90.0; `NOVA_MESH_DESKTOP_INPUT_ENABLED=false`
  (or `mesh.desktopInput: false` in the config) turns it off. Only
  authenticated owner runs. Nothing reaches a node without the node's own
  opt-ins below.
- Node daemon: `NOVA_MESH_CAPTURE_ENABLED=1`, `NOVA_DESKTOP_INPUT_ENABLED=1`,
  `NOVA_CAPTURE_SOCKET`, `NOVA_CAPTURE_TOKEN_FILE`.
- Workstation unit, for `open_url` only: `NOVA_WORKSTATION_OPEN_URL_ALLOW`
  (comma-separated host names, each also covering its subdomains; empty means
  no page may be opened) and `NOVA_WORKSTATION_BROWSER` (absolute path to a
  root-owned, non-writable browser binary). A snap browser does not start
  inside a system service cgroup; install a non-snap build for the workstation.

`open_url` accepts only public `http(s)` host names: no IP literals, no
credentials in the URL, no `localhost`, `.local`, `.internal`, `.lan`,
`.home`, `.arpa` or `.ts.net`. Also restrict the workstation account's
outbound traffic to the internet at the host firewall (private ranges,
CGNAT/tailnet, link-local and multicast rejected for its UID), so a page that
resolves to a private address is still unreachable.

Mounting the workstation socket into a container: mount a directory whose
inode survives workstation restarts (for example created by `tmpfiles.d`,
with `RuntimeDirectory=` cleared in a drop-in and stale `private/`,
`desktop.sock` and `ready.json` removed in a privileged `ExecStartPre`). A
bind mount of a systemd `RuntimeDirectory=` keeps pointing at the deleted
directory after the service restarts (for example after needrestart), and
every capture then fails.

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
