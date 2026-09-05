# Dashboard and Nova Trust Guide (v2.72)

Nova's web-based monitoring and control interface.

---

## Access

**URL**: http://localhost:18789
**Auth**: Bearer token from `.nova-gateway-token`

Dashboard starts automatically with Nova.

---

## Overview Tab

### Stats Cards
- **Tokens Today** — API tokens consumed
- **Cost Today** — Estimated API cost
- **Requests Today** — Total LLM requests
- **Active Sessions** — Connected users

### System Status
- Node health (Master, Pi5, Jetson)
- Memory usage
- Model status

---

## Chat Tab

Chat directly with Nova from the browser:
- Full WebSocket connection
- Typing indicator
- Message history
- Streaming responses

---

## Memory Tab

Browse Nova's long-term memory:
- View stored memories by type
- Search by keyword
- See instincts (L23 behavioral rules)

---

## Layers Tab

**Monitor the 23-layer system:**
- See which layers are active
- View registered tools (Smart Router: 112 total, ~22 per request)
- Check layer call counts
- Red-Team security score

---

## Mesh Tab

**Monitor all mesh nodes:**
- Pi5 status + heartbeat
- Jetson status + heartbeat
- VRAM usage per node
- Deployed skills

---

## Self-Updates Tab

Review Nova's self-improvement proposals:
- Type (bugfix, feature, optimization)
- Confidence score
- AST security analysis result
- **Approve** or **Reject**

---

## Config Tab

View current configuration:
- Model settings
- Enabled features
- API key status (masked)
- SOUL.md content

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send chat message |
| `Shift+Enter` | New line in chat |
