# Tools Reference (v2.72)

Nova has **112 registered tools**, managed by the Smart Tool Router which selects ~22 per request based on context.

---

## Core Tools

### run_command
Execute shell commands (PowerShell on Windows, bash on Linux).
**Security:** 4-level injection detection. Blocked: `rm -rf /`, pipe-to-bash, base64 decode.

### write_file / read_file / list_directory
Full filesystem access. Protected paths cannot be overwritten.

### grep_search / search_files
Search in files by pattern or content.

---

## Network Tools

### ssh_command
Execute commands on remote servers (Tailscale mesh nodes).
```
ssh_command({ host: "100.64.0.21", command: "docker ps" })
```

### web_search / google_search
- `web_search` — API-based (Tavily/Brave), fast
- `google_search` — Headless browser (Playwright), more results

### browse_url / fetch_url
Open and read web pages. SSRF Guard blocks private IPs.

---

## Memory Tools

### remember / recall / forget
Long-term vector memory via LanceDB.

### save_api_key
Auto-detect and store API keys (tvly- = Tavily, sk-or- = OpenRouter).

---

## Self-Management

### save_config
Modify `xaventra.config.json` at runtime.
```
save_config({ section: "telegram", values: { enabled: true } })
```

### create_tool
Create an inert, hash-addressed Nova Studio Forge proposal. It is not registered
or executed until sandbox, benchmark, canary and Owner gates have verified
evidence.

### list_custom_tools
List all self-created tools.

---

## Vision

### screenshot
Capture screen and analyze with LLM.

---

## Mission Tools

### start_autonomous_mission
Multi-step goal decomposition. Used for large tasks ("build an app").

---

## Mesh Tools

### mesh_status
Check all node health, VRAM, loaded models.

### deploy_skill
Sign and deploy a custom tool to all mesh nodes.

---

## Tool Categories

| Category | Count | Tools |
|----------|-------|-------|
| File | 5 | read_file, write_file, list_directory, search_files, grep_search |
| Shell | 2 | run_command, ssh_command |
| Search | 3 | web_search, google_search, browse_url |
| Memory | 4 | remember, recall, forget, save_api_key |
| Config | 3 | save_config, create_tool, list_custom_tools |
| Vision | 1 | screenshot |
| Mesh | 2 | mesh_status, deploy_skill |
| Mission | 1 | start_autonomous_mission |

Plus ~90 specialized tools (PDF, GAEB, Docker, Git, etc.) loaded dynamically.

---

## Smart Tool Router

Not all 112 tools are sent to the LLM — that would waste tokens. The Smart Tool Router analyzes the user's message and selects the ~22 most relevant tools per request.

**Categories:**
- `always` — Core tools (always included)
- `file_ops` — File operations
- `network` — SSH, web, search
- `coding` — Code analysis, AST
- `system` — Config, monitoring
- `creative` — Image gen, writing
