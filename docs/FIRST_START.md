# First start without a questionnaire (2.85)

A new installation needs no terminal wizard. Install, start, and Xaventra sets
itself up; the Desktop app asks at most three questions.

## Install and start

| System | Install | Start |
|---|---|---|
| Windows | double-click `install.cmd` | double-click `start.cmd` |
| Linux, macOS, WSL | `sh install.sh --desktop` | `npm run start:fast`, then `npm run desktop:dev` |

`install.cmd` runs the same portable setup as `install.ps1` and `install.sh`
(`scripts/setup.mjs --desktop`). It needs Node.js 22+, no admin rights, and
creates no service, firewall rule or model download. `start.cmd` starts the
Core without a rebuild and opens the Desktop app.

The terminal wizard (`npm run cli -- setup`) still exists for experts.

## What happens on the first start

1. **Safe defaults instead of exit 1.** Without `xaventra.config.json` (or a
   legacy `nova.config.json`) the daemon seeds the installer's defaults
   (`seedConfiguration` in `scripts/setup.mjs`): local model first
   (`provider: local`, `model: auto`, no cloud fallbacks), no channels, no Mesh
   peers, no MCP servers, loopback only, empty Telegram allowlist. A new `.env`
   gets a random REST token and a random Desktop owner token. The marker
   `.nova-data/onboarding.json` (`state: pending`) switches on first-start mode.
   **An existing configuration is never touched and never gets the marker.**
2. **Doctor and self-setup first** (`src/onboarding/first-start-doctor.ts`, in
   the background): the existing Doctor (`runSelfDoctor`), hardware, local model
   discovery (Ollama, LM Studio, vLLM, llama.cpp) and the self-setup scan.
   - No local chat model: a model that fits the memory comes from the signed
     install catalog (`ollama-model:qwen3` from 14 GB, `ollama-model:llama3.2`
     from 6 GB) through `proposeCatalogInstall`, i.e. the existing ticket path
     with a card. Nothing is installed without the owner's yes.
   - Repairs only through the existing recipe: catalog actions go to the
     install queue (card or standing permission). Config patches keep needing
     the owner.
   - Every failed step becomes a Doctor finding plus a failure-research case.
   - The report "was ich getan habe" is stored in the marker and shown first.
3. **At most three questions** in the Desktop app (page "Erster Start", later
   under "Mehr"): name; Telegram; found services.

## Desktop owner token on a fresh install

The Desktop app on the same computer cannot know the random owner token. On a
401 from a loopback Core, and only without a stored token, the Electron main
process calls `POST /api/desktop/onboarding/claim` once. The Core answers only
to a direct loopback client (same rules as tokenless Desktop mode: no proxy
headers, no foreign Host, no cross-site browser), only while the first start is
pending, only once, and only within 24 hours of seeding. The main process
stores the token with `safeStorage`; the renderer cannot call the route and
never sees the token. Any process of the same OS user could read the `.env`
anyway, so the claim grants nothing a local user did not already have.

## Telegram pairing (no IDs, token pasted once)

1. The page links to @BotFather. The owner pastes the bot token once into a
   hidden field. The Core checks it with `getMe`, stores it only in `.env`
   (`TELEGRAM_BOT_TOKEN`, file mode kept, 0600 for new files), enables the
   channel and never returns or shows it again.
2. "Koppeln" issues a one-time code and shows `https://t.me/<bot>?start=<code>`
   as a link and QR code. Tapping it sends `/start <code>`; the sender becomes
   owner in `channels.telegram.allowFrom`.

The code has 144 bits, only its sha256 is stored, comparison is constant-time,
it is valid for 10 minutes and works once, in private chats only. The adapter
checks it before its allowlist and never queues it for the pipeline. Pairing is
off when `TELEGRAM_ALLOW_FROM` in `.env` already fixes the owner.

Limitation: a bot token saved during the first start becomes active with the
next start of the Core (the channel gateway treats a skipped Telegram start as
finished). The page says so.

## Found services (package A)

The first start builds no catalog and no connect flow. It only points to the
Desktop view "Verbindungen" of package A through a small port,
`src/onboarding/connections-port.ts`. Docking point when package A is merged,
one line at its startup:

```ts
registerConnectionsProvider(listConnections)
```

Only `status` (`gefunden`, `moeglich`, `verbunden`) and `title` of the entries
are read. Until then the step says the view comes with the next package.

## Draft: adding more computers by code (not built yet)

Today `NodeEnrollmentService` (`src/desktop/node-enrollment.ts`) records a
draft with SSH host, user and host-key fingerprint and stops at
`awaiting-node`; nothing joins by itself. Planned path, built on what exists:

1. Main: "Rechner hinzufügen" issues a one-time join code (same shape as the
   Telegram code: random, hash only, 15 minutes, single use) bound to an
   enrollment record, plus a signed join ticket (`signTicket` /
   `verifyTicketEnvelope` / `claimTicketOnce` from `src/install/signed-ticket.ts`).
2. New computer: installer and first start accept the code (Desktop field or
   QR). The node sends its Mesh Ed25519 public key (`MeshIdentity`) with the
   code to the Main over HTTPS/Tailnet.
3. Main: a card "Rechner X aufnehmen?" with the key fingerprint; on yes the key
   enters the peer trust list (no `allowTofu`) and the enrollment moves to
   `verified` after the first fenced heartbeat.

No SSH and no config editing for the owner. Open: transport for a node that is
not yet in the Tailnet, rate limits, and what a code-only join may install.

## Open points

- Signed installers (Windows MSI/MSIX, macOS notarised app, Linux packages) that
  bundle Node.js, so that Node does not have to be installed first. Needs
  signing certificates; `npm run desktop:package` builds unsigned packages only.
- `start.cmd` runs the Core in a minimised console window; a background service
  or autostart is not set up (deliberately: no service without the owner).
- Double-click start on Linux/macOS (`.desktop` file, `.command`).
- Live start of Telegram after saving the token (see limitation above).
