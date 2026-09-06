# Xaventra Desktop and Xaventra Studio

Xaventra Desktop is the cross-platform operator client for Xaventra Core. It is an
Electron shell around a narrow, authenticated Desktop API; it is not a second
agent runtime. Every native chat still enters the canonical Message Pipeline,
Execution Kernel, Tool Gates, Outcome Ledger and user-scoped Memory.

## Platform packages

| Platform | Package |
|---|---|
| Windows | `.exe` (NSIS or portable) |
| macOS | `.dmg` |
| Linux | `.AppImage` or `.deb` |

Each target is built on a suitable build host. A Windows `.exe` does not run on
macOS or Linux, although the Electron source is shared. The renderer could be
migrated to React or Next.js later; Next.js alone would be a browser UI and
would not replace the node-local keychain, secure preload bridge or desktop
integration supplied by Electron.

## Start and package

```bash
npm run desktop:install
npm run desktop:dev
npm run desktop:build
npm run desktop:package
```

The fenced Main Core API must already be running. The default endpoint is
`http://127.0.0.1:3011`; a workstation can map that loopback port to the current
Main with an authenticated SSH/Tailscale tunnel. Remote endpoints require HTTPS
and an explicit `NOVA_DESKTOP_API_TOKEN`.
Tokens are encrypted with Electron `safeStorage` on the local workstation and
are never written to rooms, Memory, Mesh state or the Capability Graph.
Plain startup does not probe the OS keychain: settings show availability as
unverified until a credential operation. Storing/using a token checks real OS
encryption and may require an OS keychain prompt; Linux's `basic_text` fallback
is refused. Signed macOS keychain interaction remains a separate release gate.
Changing the Core endpoint clears the previous endpoint's stored token. Enter
the new Core's token in connection settings before reconnecting.

The Desktop API starts only on a node that owns both the canonical `nova-main`
lease and the exclusive `dashboard` lease. Its bootstrap response reports the
Main node ID and both fencing epochs. The client therefore gets all Nodes,
models and runtimes from the Main's canonical Mesh/Capability Graph instead of
inventorizing only the workstation on which Electron happens to run.

## Nova-controlled Desktop

Nova can navigate its own client through the governed `desktop_control` tool.
Allowed actions are `navigate`, `open_room`, `select_model`, `refresh`, `focus`,
`notify`, the result-bearing `capture_screen`, and the exact-client
`workspace_operation`. The Main stores each command
as an owner- and client-scoped typed envelope;
the addressed Desktop client must acknowledge success or failure. Commands
expire after ten minutes. There is deliberately no arbitrary DOM script,
Electron IPC, filesystem or shell payload.

### Local project / IDE context

A room may bind one folder selected through the native Electron directory
picker. The filesystem stays on the interactive workstation: the Main stores
only an opaque workspace ID and sends typed `list`, `read` or `search` requests
back to the exact authenticated Desktop client. The returned evidence includes
the relative path and, for reads, a SHA-256 content hash.

This is Nova's current IDE-aware boundary: she can understand and inspect the
selected codebase through natural-language requests such as “Suche im Projekt
nach dem Router” without a slash command. It does not yet observe an editor's
active tab, cursor or unsaved buffer; that requires a future VS Code/JetBrains
adapter using the same typed client contract. `desktop_workspace` is read-only.
It rejects absolute paths, parent traversal, secret/credential files, `.git`,
dependency trees, generated build output, binary files and files above the
bounded text limit.

For a Desktop chat, `desktop_screenshot` is executed by the interactive client,
not by a headless Main. Electron captures the primary display, compresses it
below the Dashboard transport limit and returns it through the authenticated
acknowledgement. Core verifies the MIME signature, writes the image to a
server-generated path, hashes it and passes the bytes to the normal Nova vision
follow-up. The raw base64 payload is not stored in the command queue and the
Desktop path does not send the image to Telegram.
Core retains at most 30 captures and removes captures older than seven days.

## Chat and settings

- Messages scroll inside the fixed application shell; the composer remains
  visible at the 1120 × 720 minimum window size.
- A long request immediately shows the submitted message, elapsed seconds and
  a deliberately coarse processing phase. These labels do not claim a tool
  succeeded before Tool Evidence exists.
- Safe Markdown presentation supports paragraphs, emphasis, lists, links,
  quotes and code after HTML escaping.
- Settings separate connection/identity, Main fencing, chat behavior, layout,
  credential rules and connection testing. Only non-secret UI preferences are
  stored beside the encrypted connection configuration.
- Native replies expose the canonical Run ID, exact model/Node route, duration,
  tool outcomes and verified-evidence count. A tool-schema probe is displayed
  separately from production tool-success samples.

Run `npm run desktop:build` then `npm run check:desktop-ui` for the isolated
packaged-client check. It creates a disposable profile and simulated loopback
Core, uses real keyboard/mouse input and preserves reports/screenshots in the
printed temporary directory. It never reads your saved Desktop connection or
captures the full display. On Linux without a desktop session, use
`xvfb-run -a npm run check:desktop-ui`. CI runs the same package checks on all
three operating systems and retains synthetic screenshots/reports, not profiles.
This is UI/API-contract evidence, not live-model or production-Mesh evidence.
The disposable Linux CI runner configures the package's Chromium sandbox helper;
the test does not use `--no-sandbox` or disable renderer isolation. Build/package
commands use `--publish never`; uploading a binary is a separate release action.

Connection settings stay accessible during startup and failed authentication.
Bootstrap attempts use a five-second network deadline and at most five tries;
opening settings cancels automatic UI replacement. Chat keeps its separately
configured longer timeout. A saved connection can recover without an app restart.

Unsent drafts and reading positions stay in this app session, per room, across
model selection, specialist toggles and navigation. They are **not** durable
across app restart. A failed send restores the text for review; it is never
automatically resubmitted, because an uncertain network failure is not proof
that the server performed no action. Pending messages belong only to their
originating room. Elapsed time alone never claims that tools were executed.
Preferences, unlike drafts, are persisted in the local Desktop profile.
Changing endpoint or principal discards session drafts/history before loading
that connection. Connection changes are deferred while a submission is pending.

## Workspaces

- Topic and group rooms can select one or more bots and preferred Nodes.
- The model picker offers automatic Outcome Router selection or a verified,
  exact Node×Runtime×Model route. Each pinned invocation receives an isolated
  LLM client so concurrent rooms cannot change one another's model.
- Native Nova bots share the same kernel while retaining room/bot conversation
  continuity. The canonical Memory principal remains the user.
- Hermes and OpenClaw agents may be connected through explicit endpoints.
  Their output is federated content, never Nova Tool Evidence.
- Nodes are inventoried through Mesh and Capability Graph state. Enrollment
  requires an Owner decision and a verified SHA-256 SSH host-key fingerprint.
- Blue Team is defensive. Red Team executes only Nova's fixed local self-test
  vectors and never accepts external targets or payloads.

## Nova Studio

Nova Studio exposes governed capability modules inspired by three
reference projects without embedding their runtimes as a second authority:

- [ADA Local](https://github.com/nazirlouis/ada_local): local voice, wake word,
  speech and smart-home interaction patterns.
- [ADA v2](https://github.com/nazirlouis/ada_v2): visual awareness, CAD, 3D
  printing, browser automation and project workspace patterns.
- [Ada-SI](https://github.com/nazirlouis/Ada-SI): a visible Skill Forge and
  skill-maturity workflow.

Existing Nova tools back each module. Missing tools are shown honestly as
`partial` or `setup-required`; the UI does not claim that a capability exists
because another project demonstrates it.

### Skill Forge safety contract

All generated-skill entry points (`build_skill`, `create_skill`, `create_tool`
and `create_runtime_tool`) now create the same inert, hash-addressed Forge
proposal. The only allowed progression is:

```text
proposed -> sandbox-authorized -> sandbox-tested -> benchmark-passed
         -> canary-tested -> approved -> active
```

Sandbox, benchmark and canary stages require independently verifiable evidence.
Owner approval cannot skip a stage. Telegram's first approval authorizes only
the sandbox attempt. Nova does not run arbitrary Ada-SI Python, install proposed
`pip` packages, expose host secrets or activate generated code directly.

## Trust boundaries

- Desktop API access is localhost-only without a token; remote access needs a
  dedicated `NOVA_DESKTOP_API_TOKEN` and an HTTPS endpoint.
- Electron uses `contextIsolation`, renderer sandboxing, no Node integration,
  a strict CSP and a narrow preload bridge.
- External HTTP is limited to loopback. Non-loopback agent and Core endpoints
  must use HTTPS.
- The Desktop API exposes only the active user's governed Memory scope and
  filters Outcome runs by principal.
- Node credentials and provider OAuth remain `User x Node`; the desktop sees
  capability status, not credential values.

## Execution and memory identity (2.78.4)

Room/profile ownership uses the Desktop principal from the connection settings.
Core execution receives `desktop:<principal>` as its channel-bound user ID,
then applies explicit `userPrincipals` mappings. Trust and governed Memory use
that same resolved identity. Display aliases do not grant access. Existing
ledger history is not rewritten, and runs without an owner are not exposed.

Native messages enter the pipeline unchanged, including slash commands. The
native runner restores its principal/room/bot session checkpoint; the Desktop
does not prepend a second copy of the room transcript to current instructions.

After `npm run build` and `npm run desktop:build`, run
`npm run check:desktop-core` (Linux: `xvfb-run -a npm run check:desktop-core`).
This uses production API/pipeline/tools/validator/ledger code with temporary
profiles, synthetic files and a scripted loopback model. It complements rather
than replaces the simulated-API UI check or live model/channel/HA acceptance.
See [2.78.4 evidence and limits](VERIFICATION_2.78.4.md).
