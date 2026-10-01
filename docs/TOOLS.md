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

### build_skill / create_skill
Build a tool in the Werkzeug-Schmiede: ESM code, manifest (`net`, `fs`, `wirkung`)
and test cases as data; `create_skill` lets the local learning model write the
draft. Runs only in the sandbox; active tools appear as `forge_<name>`. See
[TOOL_FORGE.md](TOOL_FORGE.md).

### list_skills / delete_skill
List the forge tools with status and counters; `delete_skill` switches one off.

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


---

## Tool Categories

| Category | Count | Tools |
|----------|-------|-------|
| File | 5 | read_file, write_file, list_directory, search_files, grep_search |
| Shell | 2 | run_command, ssh_command |
| Search | 3 | web_search, google_search, browse_url |
| Memory | 4 | remember, recall, forget, save_api_key |
| Config | 1 | save_config |
| Werkzeug-Schmiede | 4 | build_skill, create_skill, list_skills, delete_skill (+ active `forge_*`) |
| Vision | 1 | screenshot |
| Mesh | 1 | mesh_status |
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
