# Telegram Bot Setup and HA (v2.85.2 candidate)

Configure Nova as a Telegram bot with interactive actions, user isolation and
fenced Main failover.

---

## Create Bot

1. Open Telegram → Search `@BotFather`
2. Send `/newbot`
3. Bot name: "Nova AI"
4. Username: "YourNovaBot" (must end in `bot`)
5. Copy the token

---

## Configure

Add to `xaventra.config.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456789:ABCdef...",
      "allowFrom": ["YOUR_CHAT_ID"]
    }
  }
}
```

### Get Your Chat ID
Send `/start` to `@userinfobot` on Telegram.

---

## Features

### Text Messages
Just type normally. Nova responds in German.

A lone HTTP(S) link selects guarded URL inspection. A private-address policy
denial does not prove an Internet outage or a failed service. URL requests avoid
cached responses; network and policy failures must be distinguished. Private
targets remain blocked by the public fetch tool. For a Tailscale HTTPS landing
page, `mesh_inspect_url` maps local Tailscale DNS/IP evidence to a fresh mesh
node before an owner-only, bounded GET. Only port 443 and `/` without query,
credentials or redirects are allowed; TLS validation stays enabled. Unknown,
offline or ambiguous peers fail closed. Snap CLI/socket discovery works under
a service account without sudo. A hostname alone is not a service map, and a
page title is not a functional test of the service advertised on that page.

Model questions combined with other questions receive current server metadata
without dropping the other task. The configured alias and server-reported model
name are distinct; routing/failover may still select a different model per call.
Short corrections such as `ns1 sorry` retain the immediate tool-routing context.
Node status comes from live mesh evidence, not an empty knowledge-graph search;
unmeasured connectivity or installation motives must be reported as unknown.

### Request lifecycle

Long tasks keep one silent progress bubble and edit it in place. Step updates no
longer create a new Telegram message every time. Before a final answer,
clarification or error is delivered, Nova removes the progress bubble. Markdown
tables are rendered as vertical mobile cards. Normal final answers and approvals
retain Telegram's regular notification behavior.

Verbose mode adds a compact Trust footer with the selected cognitive mode,
actual model/node, executed tools, verified evidence count and duration. Raw
provider reasoning is never sent to Telegram.

### Voice Messages
Send voice notes → Whisper transcription → Nova responds.

### Images
Send images → L10 Vision analysis.

### Desktop screenshots (candidate)

Receiving an image is separate from capturing and sending the host desktop.
The 2.78.57 screenshot corrections require an explicitly enrolled capture agent
and an exact `desktop_screenshot` rule for the authenticated Telegram principal.
Remote desktop control remains denied by default; a locked session must be
unlocked locally, never bypassed. Production screenshot delivery is not yet
qualified. See [capture enrollment and acceptance](./SCREENSHOT_DELIVERY.md)
for failure diagnosis and the required correlated capture/delivery receipts.

Screenshot spelling variants and plurals are recognized. Requests for images of
mesh nodes (including all nodes) use `mesh_screenshot` with a current node ID or
`all`, never `desktop_screenshot` as a different-node substitute. Each node must
locally enroll its own graphical session agent (`NOVA_MESH_CAPTURE_ENABLED=1`);
headless, locked or unenrolled nodes return individual failures. The signed,
Main-fenced capture protocol uses only direct encrypted/local transport and
verifies image hashes. Only actual owner-bound Bot API send receipts establish
delivery; partial results never claim all pictures were sent. See the
[autonomy guide](./AUTONOMY_GUIDE.md) for enrollment and limits.

A bounded mixed request such as "was können deine nodes? send mir einen screnn
shot vbon jeden" retains the node reference across the question mark. A previous
erroneous target question for that request is discarded, not replayed. Successful
Mesh observations remain in the reply alongside the explicit capture limitation;
without such observations the node capabilities are labelled unverified. This
does not supply a target for additional installations/deletions or another recipient.

### Evidence-based notifications

Proactive messages require fresh evidence, impact/confidence thresholds,
deduplication and a notification budget. Dream and social check-in loops are
disabled by default. Diagnostics may run automatically; deployments,
configuration changes and self-modification retain their approval gates.

### Interactive Buttons

| Command | Buttons |
|---------|---------|
| `/help` | System, Memory, Session, Bots |
| `/status` | Refresh, Model switch, Layers |
| `/models` | Provider → Model (2-step) |
| `/persona` | Nova, Business, Kreativ, DevOps |
| `/memory` | Refresh, Clear, Search |

---

## All Commands

| Command | Description |
|---------|-------------|
| `/help` | Interactive help |
| `/status` | System status, uptime, tokens |
| `/layers` | 23-layer overview |
| `/models` | Model selector |
| `/model <name>` | Switch model |
| `/persona` | Persona presets |
| `/think on/off` | Thinking mode |
| `/memory` | Memory status |
| `/clear` | Clear session |
| `/info` | Nova info |
| `/nodes` | Mesh node status |
| `/login` | Antigravity OAuth |

---

## Multi-User

```json
{
  "channels": {
    "telegram": {
      "allowFrom": ["CHAT_ID_1", "CHAT_ID_2"]
    }
  }
}
```

Each user gets isolated session memory.

## Mesh ownership

Do not run independent Telegram pollers on every node. A channel-capable node
starts polling only after it owns both the canonical `nova-main` and `telegram`
leases with a current fencing token. Standbys keep their node-local token but
stay disconnected. Workers should set:

```bash
NOVA_NODE_ONLY=true
NOVA_TELEGRAM_MODE=disabled
NOVA_NO_TELEGRAM=true
NOVA_MAIN_ELIGIBLE=false
```

An HA standby uses `NOVA_TELEGRAM_MODE=standby`; that does not authorize
polling by itself. Credentials are local to each node and are never copied by
Mesh, Memory, Supabase or release artifacts.

Every inbound update and outbound Bot API effect revalidates both leases at the
last possible boundary. This includes direct legacy SDK calls, message chunks,
edits, files, reactions, typing/progress indicators and proactive sends. Losing
authority retires the poller, clears timers and fences late callbacks; stopping
the old poller remains allowed so cleanup cannot deadlock behind the lost lease.
This closes an in-process race but does not replace a controlled physical-node
partition and live Telegram handover test.

---

## Troubleshooting

### Bot not responding?
- Check `channels.telegram.enabled: true`
- Verify `allowFrom` contains your Chat ID
- Verify one node holds both `nova-main` and `telegram` leases
- Check logs for `409 Conflict` or `Poller fenced`
- Check daemon/container logs rather than model output

### `409 Conflict: terminated by other getUpdates request`

Another process is polling with the same token. Stop retired/duplicate Nova
instances first. Nova 2.72.1 stops the losing poller and revalidates its live
lease before any retry, but an old installation cannot be remotely fenced by
new code it does not run.

If the process cannot be found, use BotFather `/revoke`, select the bot, and
install the replacement token only in the local secret stores of the Main and
eligible standby. Restart them one at a time and confirm exactly one poller.

### Wake-up calls not arriving?
- Check `allowFrom[0]` is your admin Chat ID
- Check `TELEGRAM_BOT_TOKEN` env var as fallback
- Check the event passed the proactive evidence and notification-budget policy
