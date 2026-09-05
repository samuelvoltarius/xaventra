# Telegram Bot Setup and HA (v2.74.1)

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

Add to `nova.config.json`:

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
