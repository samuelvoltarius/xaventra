# Troubleshooting (v2.72)

## Telegram shows “LLM/Tools laufen” for a simple chat

From 2.72.2 onward, session summarization never blocks an interactive response.
The foreground path injects the last durable summary plus a bounded extractive
view; the optional LLM refresh runs separately with one eight-second attempt.
If a simple prompt still takes longer than 25 seconds, inspect the trace for the
actual provider/model timeout rather than treating summary generation as part of
the user task.

Common issues and fixes.

---

## Nova Won't Start

### "Cannot find module"
```bash
npm install
npx tsc  # or npm run build
```

### "Port 18789 already in use"
```bash
# Windows
netstat -ano | findstr 18789
taskkill /PID <PID> /F

# Linux
lsof -i :18789
kill -9 <PID>
```

### "ENOENT: xaventra.config.json"
Create `xaventra.config.json` from the template. See [Configuration](./CONFIGURATION.md).

---

## Telegram Not Working

### Bot doesn't respond
1. Check `channels.telegram.enabled: true` in config
2. Verify `allowFrom` contains your Chat ID
3. Check token is correct
4. Verify the same node owns fresh `nova-main` and `telegram` leases
5. Check the active daemon/container logs for `409 Conflict`, `Poller fenced`,
   LLM routing and Tool Evidence

### Repeated Telegram 409 conflicts

Telegram permits only one `getUpdates` poller per bot token. Verify active,
standby and retired hosts; an old process can consume updates even when it no
longer appears in the default Mesh view. Workers must have Telegram disabled.

Nova 2.72.1 fails closed after 409 and retries only as the revalidated live
lease holder. This prevents updated stale nodes from stealing messages. It
cannot stop a legacy binary that is still using the token. If that process is
unreachable, rotate the token with BotFather `/revoke`, update only node-local
secrets on Main/HA standby, and restart one candidate at a time.

Never put the replacement token in Git, Memory, Supabase, Mesh payloads or a
release archive.

### Getting your Chat ID
Send `/start` to `@userinfobot` on Telegram.

---

## Mesh Nodes Offline

### Node not connecting
```bash
# Check Tailscale
tailscale status

# Check if node is reachable
ping 100.64.0.21

# Check node logs
ssh xaventra@100.64.0.21 'tail -20 /tmp/nova-node.log'
```

### Deploy failed

Do not bypass a failed signed rollout with an ad-hoc tar pipe. Inspect
`/update status`, disk headroom, signature/hash verification, runtime marker,
heartbeat and the node receipt. Retry the same immutable release after fixing
the failed prerequisite. See [Signed Mesh Releases](./MESH-RELEASE-UPDATES.md).

---

## LLM Issues

### "No LLM available"
1. Check Ollama is running: `curl http://localhost:11434/api/tags`
2. Check model exists: `ollama list`
3. Pull model: `ollama pull gemma3:4b`

### OOM (Out of Memory) on GPU
The VRAM Manager should handle this automatically. If not:
```bash
# Check VRAM
nvidia-smi  # or
ollama ps

# Unload all models
curl -X DELETE http://localhost:11434/api/generate
```

### Slow responses
- Use smaller model (gemma3:4b instead of 12b)
- Check if Predictive Provisioning is warming models
- Check CPU/GPU usage

---

## Security Issues

### "SSRF Guard blocked request"
The target IP is in a blocked range. To allow:
- Edit `src/security/ssrf-guard.ts` → `ALLOWED_LOCAL_HOSTS`
- Add the IP to the allowlist

### "Tool Validator blocked command"
Your command triggered injection detection. Check for:
- Pipes (`|`), backticks, `$()`
- More than 5 chained commands
- Commands over 500 chars

### Red-Team found bypasses
Check `.nova-data/red-team/last-result.json` for details. Add guard rules for any bypasses found.

---

## Memory Issues

### LanceDB not working
```bash
# Check if directory exists
ls -la .nova-lancedb/

# Reinitialize
rm -rf .nova-lancedb/
# Restart Nova — it will recreate
```

### Instincts not learning
- Need minimum 2 corrections of same type within 7 days
- Check `.nova-data/instincts/active-instincts.json`
- Strength must reach ≥30 to be active

---

## Performance

### High memory usage
- Reduce `memory.maxShortTermMessages` (default: 50)
- Use smaller models
- Check Worker Pool size

### Startup takes too long
- Predictive Provisioning adds ~5s on startup (model pre-warm check)
- VRAM Manager queries Ollama API on start
- Disable unused channels in config

---

## Logs

| Log | Location |
|-----|----------|
| Main daemon | `nova-local.log` |
| Edge nodes | `/tmp/nova-node.log` |
| Dreams | `.nova-data/reflector/last-dream.json` |
| Red-Team | `.nova-data/red-team/last-result.json` |
| Instincts | `.nova-data/instincts/active-instincts.json` |
