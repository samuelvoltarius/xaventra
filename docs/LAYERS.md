# Nova — Complete Layer Reference

> All 44 cognitive layers with descriptions, wiring status, and integration details.
> Last updated: v2.74.1 (2026-08-26)

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ **Wired** | Directly imported and initialized in `daemon.ts` |
| ⚡ **Via pipeline** | Loaded lazily through `message-pipeline`, command router, or sub-system |
| 🔧 **Autonomous** | Self-initializing; runs on its own schedule without direct daemon wiring |

---

## Layer 0 — Resilience & Foundation

### `L0-health-monitor` ✅ Wired

**What it does:** Monitors system resources every 5 minutes — disk free space, RAM usage percent, `.nova-data` directory size. Fires warning callbacks when thresholds are exceeded. Tracks historical health for trend detection.

**Key exports:** `runHealthCheck()`, `getLastHealthStatus()`, `setWarningCallback()`

**Wiring in daemon.ts:**
- Called in heartbeat loop (every 5 min)
- Warning callback routes critical alerts to Telegram admin

---

### `L0-self-repair` ✅ Wired

**What it does:** Error detection and automatic fix engine for runtime failures. Maintains a backup/restore capability so Nova can recover from broken states. Integrates with `nova-doctor` models for structured diagnosis.

**Key exports:** `getSelfRepairEngine()`, `handleUncaughtError()`, `SelfRepairEngine`

**Wiring in daemon.ts:**
- Registered as `process.on('uncaughtException')` + `process.on('unhandledRejection')` handler
- Engine instance stored in `state.selfRepair`

---

### `L0-supervisor` ✅ Wired

**What it does:** Post-response supervision — detects Pi→Nova identity confusion in responses, retries on empty outputs, manages session resets, handles model fallback chains, learns error patterns for future prevention, and runs the internal heartbeat task scheduler.

**Key exports:** `superviseResponse()`, `getSupervisor()`, `trackPattern()`, `scheduleTask()`, `startHeartbeat()`

**Wiring in daemon.ts:**
- `startHeartbeat()` called with task dispatch callback
- `superviseResponse()` called after every LLM response in message pipeline
- Pattern learning enabled for error types

---

### `L0-tool-autorepair` ✅ Wired

**What it does:** Intercepts tool call failures automatically. Strategies: auto-create missing files, install missing npm packages, create required directories, retry with modified params. Falls back to L8 sub-agent after max retries.

**Key exports:** `getToolAutoRepairEngine()`, `repairAndRetry()`, `wrapToolHandler()`

**Wiring in daemon.ts:**
- Tool execution wrapped via `wrapToolHandler()`
- Repair engine accessed on tool failure path

---

## Layer 1–5 — Core Infrastructure

### `L01-unified-channels` ✅ Wired

**What it does:** Omnipresence abstraction layer. Normalizes messages from Telegram, WhatsApp, VoIP, PWA Dashboard, Discord into a unified `NovaMessage` format. Routes outgoing messages to the correct channel adapter.

**Key exports:** `ChannelAdapter`, `getChannelRouter()`, `CLIChannel`

**Wiring in daemon.ts:**
- Router imported for message distribution to all active channels
- CLI channel created for interactive terminal mode

---

### `L02-command-factory` ⚡ Via pipeline

**What it does:** Tool lifecycle orchestration — discovery, dynamic loading, auto-repair on failure, usage analytics, hot-reload of new tools. Manages the 120+ tool registry.

**Key exports:** `ToolRegistry`, `CommandFactory`, `getToolRegistry()`

**Wiring:** Accessed through `message-pipeline.ts` tool execution path, not directly from daemon.

---

### `L03-core-runtime` ✅ Wired

**What it does:** State Machine (idle → working → waiting → error) + Message Bus (pub/sub for internal events) + Request Queue (serialized message processing) + Watchdog (detects stuck state, triggers reset).

**Key exports:** `NovaStateMachine`, `getCoreRuntime()`, `MessageBus`

**Wiring in daemon.ts:**
- Runtime instance created at startup
- State transitions managed by daemon lifecycle hooks

---

### `L04-secure-auth` ⚡ Via factory

**What it does:** Multi-provider token management (OpenAI, Anthropic, xAI, Groq, local). Auto-bootstraps from IDE environment. OAuth refresh for expiring tokens. Encrypted storage of credentials.

**Key exports:** `NovaAuthManager`, `getAuthManager()`

**Wiring:** Accessed indirectly via `llm-factory.ts` during LLM initialization.

---

### `L05-llm-adapters` ⚡ Via factory

**What it does:** Multi-provider LLM abstraction with unified `LLMAdapter` interface. Auto-discovers available models from all connected providers at startup. Implements streaming for all providers.

**Key exports:** `discoverAllModels()`, `DEFAULT_MODELS`, `SUPPORTED_PROVIDERS`

**Wiring:** Used by `llm-factory.ts` and `L18-llm-router` for model selection.

---

## Layer 6 — Memory Tiers

### `memory-governance` ✅ Authority

Single control plane above the existing stores. Every durable memory has lifecycle (`candidate → verified → canonical`), provenance, scope, conflicts and optional TTL. Observer facts, explicit `remember`, distilled facts and eligible verified tool outcomes enter here; LanceDB, Core Facts and Knowledge Graph are projections, not competing authorities. Operator review is available through `/memory governance`, `/memory review`, `/memory approve <id>` and `/memory reject <id>`.

### `L6-cold-storage` ✅ Wired

**What it does:** Reads `USER.md` (persistent user profile) and `MEMORY.md` (long-term memories) from disk at startup. Updates these files when Nova learns something important. Forms the "cold storage" tier of the 5-tier memory stack.

**Key exports:** `ensureColdStorage()`, `readUserMd()`, `readMemoryMd()`

**Wiring in daemon.ts:**
- `ensureColdStorage()` called at startup
- Files loaded into `state.coldStorage`

---

### `L6-core-facts` ⚡ Via prompt

**What it does:** Tier-0 memory. Maintains ~50 high-confidence facts about the user, their projects, and preferences — auto-extracted from `auto-observer`. These facts are injected into EVERY system prompt to give Nova instant context without searching.

**Key exports:** `addFact()`, `getCoreFacts()`, `getFactsByCategory()`

**Wiring:** Facts injected in `message-pipeline.ts` system prompt builder.

---

### `L6-session-summary` ⚡ Via pipeline

**What it does:** Tier-2 memory compression. When a conversation exceeds ~20 messages, summarizes older messages using the internal LLM (Ollama or cloud) and replaces them with a compressed summary. Keeps context window lean.

**Key exports:** `loadSummary()`, `saveSummary()`, `summarizeMessages()`

**Wiring:** Called by `message-pipeline.ts` before building context for LLM.

---

## Layer 7 — Learning & Adaptation

### `L7-learning` ✅ Wired

**What it does:** Correction learning (records when user corrects Nova and learns the pattern), skill synthesis (creates reusable knowledge from repeated patterns), and multi-agent swarm coordination (shares learned skills across agent instances).

**Key exports:** `CorrectionLearner`, `SkillSynthesizer`, `getAgentSwarm()`

**Wiring in daemon.ts:**
- Heavy wiring: correction learner + skill synthesizer imported
- `setL7LLM(state.internalLlm)` called — internal LLM used for synthesis
- Swarm coordination enabled for multi-agent scenarios

---

### `L7-tool-learning` ⚡ Via L7

**What it does:** Records examples of successful and failed tool usage. Extracts patterns (which params work, which fail). Builds a tool-specific knowledge base that informs future tool calls.

**Key exports:** `recordToolUsageExample()`, `extractToolPattern()`, `getToolLearningStats()`

**Wiring:** Integrated into L7-learning and `message-pipeline.ts` post-tool-execution path.

---

## Layer 8 — Meta-Learning & Safety

### `L8-meta-learning` ✅ Wired

**What it does:** Autonomous capability learning loop. When Nova encounters a capability she lacks (can't do X), she: detects the gap → researches solutions via web search → creates a new tool → tests it → saves it. True self-expansion.

**Key exports:** `getMetaLearningSystem()`, `setInternalLLM()`

**Wiring in daemon.ts:**
- System imported and initialized
- `setInternalLLM(state.internalLlm)` called for research and tool creation

---

### `L8-prisma-guards` ⚡ Via guards

**What it does:** Database safety interception. Pattern-matches all DB queries for dangerous operations: `DROP TABLE`, `TRUNCATE`, `DELETE` without `WHERE`, mass updates. Blocks or requires explicit confirmation.

**Key exports:** `checkDangerousDbPattern()`, `getDangerousPatterns()`

**Wiring:** Accessed via tool execution guard layer when Prisma/DB tools are called.

---

### `L8-sub-agent` ✅ Wired

**What it does:** Google fallback agent for when Nova is stuck. When L0-autorepair exhausts retries, spawns a background sub-agent that searches Google/web for solutions, tries them, and reports back. Has its own learning cache to remember what worked.

**Key exports:** `getSubAgentManager()`, `spawnSearchAgent()`

**Wiring in daemon.ts:**
- Manager imported; triggered by L0-tool-autorepair on max retries
- Learning cache persisted to `.nova-data/sub-agent-cache.json`

---

## Layer 9 — Idle Learning

### `L9-idle-learning` ✅ Wired

**What it does:** During idle periods (no messages for 5+ minutes), analyzes which tools and topics the user engages with most. Autonomously searches documentation and tutorials for those topics. Stores learned knowledge for injection into future responses.

**Key exports:** `getIdleLearningManager()`, `setInternalLLM()`

**Wiring in daemon.ts:**
- Manager imported and `start()` called
- `setInternalLLM(state.internalLlm)` for autonomous research
- Learning checker runs every 60 seconds

---

## Layer 10–12 — Analysis & Quality Gates

### `L10-vision` ✅ Wired

**What it does:** Screenshot capture and Vision LLM analysis. Detects layout issues, CSS regressions, accessibility problems, and visual bugs by analyzing screenshots with a vision-capable model.

**Key exports:** `getVisionAnalyzer()`, `analyzeScreenshot()`

**Wiring in daemon.ts:**
- Analyzer imported and initialized at startup
- Available for any tool or layer to request screenshot analysis

---

### `L11-project-manager` ⚡ Via commands

**What it does:** Tracks project state across sessions — active features, open tasks, tech stack, key files, recent decisions. Provides project context for new sessions so Nova doesn't forget what was being worked on.

**Key exports:** `ProjectManager`, `getProjectManager()`

**Wiring:** Accessed via `/project` slash commands and message pipeline project context injection.

---

### `L12-anti-hallucination` ✅ Wired

**What it does:** Post-response validation. Checks if Nova's response claims success when tool output shows failure. Pattern-matches success phrases against actual tool results. If mismatch detected: either corrects the response or blocks it.

**Key exports:** `validateResponse()`, `didToolFail()`

**Wiring in daemon.ts:**
- Imported as `antiHalluc`
- `validateResponse()` called in message pipeline post-processing after every tool-using response

---

### `L12-qa-agent` ⚡ Via commands

**What it does:** Test-driven development support. Before code changes: generates tests. After changes: runs tests and detects regressions. Supports Vitest, Jest, Playwright. Reports failures with context.

**Key exports:** `QAAgent`, `detectFramework()`, `runTests()`

**Wiring:** Available via `/qa` commands and triggered by L17 during autonomous code changes.

---

## Layer 13–20 — Intelligence & Optimization

### `L13-ast-analyzer` ✅ Wired

**What it does:** Real code dependency graph using AST (not regex). Tracks imports/exports, builds impact analysis ("if I change this file, what breaks?"), generates repo maps for LLM context.

**Key exports:** `getASTAnalyzer()`, `buildRepoMap()`

**Wiring in daemon.ts:**
- Analyzer imported for code impact analysis
- Used by `self_evolve` tool before applying patches

---

### `L14-cost-tracker` ✅ Wired

**What it does:** Per-request API cost tracking across all providers. Budget alerts when cost thresholds are exceeded. Auto-routes expensive requests to cheaper equivalent models. ROI dashboard integration.

**Key exports:** `getCostTracker()`, `trackRequest()`

**Wiring in daemon.ts:**
- Tracker imported; `trackRequest()` called before and after every LLM request
- Budget alerts sent via Telegram when threshold exceeded

---

### `L15-security-scanner` ✅ Wired

**What it does:** Red team security layer. Scans code for OWASP Top 10 vulnerabilities, SQL injection patterns, XSS, hardcoded secrets/API keys, insecure dependency versions. Scheduled regular scans.

**Key exports:** `getSecurityScanner()`, `scanRepository()`

**Wiring in daemon.ts:**
- Scanner imported; regular scans scheduled
- On-demand via `/security scan`

---

### `L15-self-check` ✅ Wired

**What it does:** Self-awareness layer. Tracks health of every tool (success/failure rates, consecutive failures, last diagnosis). Detects when Nova is stuck or silent when she should act. Makes proactive suggestions. Maintains `ToolHealthEntry` for every tool.

**Key exports:** `getSelfCheckManager()`, `reportToolSuccess()`, `reportToolFailure()`

**Wiring in daemon.ts:**
- Manager imported
- `reportToolSuccess/Failure()` hooked into tool execution path
- Health callback set to surface degraded/broken tools to admin

---

### `L16-business-sense` ✅ Wired

**What it does:** Requirement clarification engine. Detects vague or underspecified requests ("make it better", "fix the thing"). Generates targeted clarifying questions before taking action. Prevents wasted work on misunderstood requirements.

**Key exports:** `getBusinessSenseAnalyzer()`, `clarifyRequirement()`

**Wiring in daemon.ts:**
- Analyzer imported
- Vagueness detection runs in message pipeline pre-processing

---

### `L17-autonomous-learning` ✅ Wired

**What it does:** Never-give-up autonomous learning loop. When a task fails: (1) Analyze WHY, (2) Search for solution via web, (3) Modify approach or create new tool, (4) Retry, (5) SAVE what worked. Persists `LearningSession` records.

**Key exports:** `getLearner()`, `setInternalLLM()`

**Wiring in daemon.ts:**
- Learner imported and initialized
- `setInternalLLM(state.internalLlm)` for analysis and research
- Sessions persisted to `.nova-data/learning-sessions.json`

---

### `L18-llm-router` ✅ Wired

**What it does:** Intelligent model selection. Routes tasks to the best available model based on: task type (code/reasoning/vision/fast), complexity, cost budget, current rate limits, and node availability. Integrates with VRAM manager for local inference.

**Key exports:** `configureRouter()`, `selectModelForTask()`

**Wiring in daemon.ts:**
- Router configured during startup with all discovered models
- Background refresh every 30 minutes for fresh model availability

---

### `L19-monitoring` ✅ Wired

**What it does:** Proactive URL and service monitoring. Checks configured endpoints on schedule. Sends Telegram alerts on downtime with HTTP status, response time, and suggested fixes.

**Key exports:** `getServiceMonitor()`, `addMonitorTarget()`

**Wiring in daemon.ts:**
- Monitor imported and `start()` called
- Targets loaded from `nova.config.json` monitoring section

---

### `L20-self-improvement` 🔧 Autonomous

**What it does:** Analyzes accumulated L7 correction records to find recurring error patterns. Generates self-rules (e.g. "never use `rm -rf` without confirmation"). Injects active rules into system prompt at runtime. Rules stored in `.nova-data/self-rules.json`.

**Key exports:** Inferred from `self-rules.json` — rules active in system prompt

**Wiring:** Runs autonomously on a schedule; rules are picked up by system prompt builder.

---

## Layer 21–24 — Distributed & Optimization

### `L21-node-health` ✅ Wired

**What it does:** Cross-node health monitoring via SSH. Collects CPU, RAM, disk, temperature from all Tailscale-reachable nodes (Pi5, Jetson, DGX Spark, Mac Mini, etc.). Aggregates into mesh health view.

**Key exports:** `getNodeHealthMonitor()`, `collectNodeMetrics()`

**Wiring in daemon.ts:**
- Monitor imported; multi-node health tracking enabled
- Metrics surfaced via `/nodes` command and Telegram health reports

---

### `L22-federated-memory` ✅ Wired

**What it does:** Cross-node governance synchronization. Publishes verified/canonical lifecycle records plus rejection/supersession tombstones. Imports only hash-valid snapshots from configured trusted nodes; local Core Facts, LanceDB and KG remain rebuildable projections.

**Key exports:** `initFederatedMemory()`, `syncFederatedMemoryOnce()`, `stopFederatedMemory()`

**Wiring in daemon.ts:**
- `initFederatedMemory()` called at startup
- Sync schedule: every 10 minutes

---

### `L23-instincts` ✅ Wired

**What it does:** Develops behavioral instincts from accumulated user corrections. When a pattern of corrections is detected (e.g. user always wants German responses), creates an instinct rule that modifies system prompt behavior automatically. Builds personality from interaction history.

**Key exports:** `initInstincts()`, `getActiveInstincts()`

**Wiring in daemon.ts:**
- `initInstincts()` called at startup
- Active instincts injected into every system prompt build

---

### `L24-prompt-optimizer` ✅ Wired

**What it does:** Self-optimizes `SOUL.md` during dream cycles. Analyzes which sections cause hallucinations, language errors, verbosity, or ignored instructions. Proposes targeted modifications. Respects `[LOCKED]` sections that cannot be changed.

**Key exports:** `parseSoulSections()`, `proposeSoulOptimization()`

**Wiring in daemon.ts:**
- Optimizer initialized at startup
- Proposals generated during `subconscious-reflector` dream cycles

---

## Utility Layers (No fixed number)

### `auto-bug-fix` ✅ Wired

**What it does:** Auto-fixes TypeScript compilation errors during self-evolution. Parses `tsc` error output → sends to LLM for fix → applies patch → retries build. Used by `self_evolve` tool to ensure proposed patches actually compile.

**Key exports:** `autoFixBuildError()`, `runBuildCheck()`

**Wiring:** Imported by self-evolution pipeline; called whenever `tsc` fails during patch application.

---

### `dream-daily-digest` ⚡ Via reflector

**What it does:** Consolidates the results of all dream cycle runs (from `subconscious-reflector`) into a single daily Telegram summary. De-duplicates insights, contradictions, and suggestions across multiple dream sessions.

**Key exports:** `addToDailyDigest()`, `buildDailyDigest()`, `sendDailyDigest()`

**Wiring:** Called by `subconscious-reflector.ts` after each dream cycle completes.

---

### `memory-distiller` ✅ Wired *(new in v2.58.0)*

**What it does:** Nightly knowledge extraction layer. At 02:00 AM (Europe/Vienna) via CronerScheduler: reads today's journal, makes a structured LLM call to extract `userFacts`, `decisions`, `learnings`, `openQuestions`, writes a narrative diary entry, and pushes each extracted item as a Brain episode via `POST /add_episode`.

**Key exports:** `initMemoryDistiller()`, `runDistillation()`, `setDistillerLlm()`, `getDistillerLlm()`

**Wiring in daemon.ts:**
- `initMemoryDistiller(() => state.internalLlm)` called after journal init
- `setDistillerLlm(state.internalLlm)` for `/distill` command access
- Cron: `0 2 * * *` (02:00 AM, Europe/Vienna)

**Manual trigger:** `/distill [YYYY-MM-DD]`

**Output:** `.nova-data/memories/diary/YYYY-MM-DD.md` + Brain episodes

---

### `multi-bot` ✅ Wired

**What it does:** Spawns and manages multiple Nova instances with different personas. Each bot has its own personality, channel configuration, and memory space. Useful for running a "work Nova" and "personal Nova" simultaneously.

**Key exports:** `getMultiBotManager()`, `createBot()`

**Wiring:** Manager imported; bot configurations loaded from `nova.config.json`.

---

### `multi-user-workers` ✅ Wired

**What it does:** Worker pool for multi-user load isolation. Creates dedicated worker processes for heavy users to prevent one user's long-running task from blocking others. Manages per-user state isolation.

**Key exports:** `getWorkerPool()`, `spawnWorkerForUser()`

**Wiring in daemon.ts:**
- Worker pool imported; load balancing enabled for configured user threshold

---

### `predictive-provisioning` ✅ Wired

**What it does:** Learns daily usage patterns (which models are used at which times). Pre-warms models 15 minutes before predicted use. Prevents cold-start latency for frequently-used inference nodes.

**Key exports:** `recordModelUsage()`, `computeNextPreWarmSchedule()`

**Wiring in daemon.ts:**
- Pre-warming initialized at startup
- Usage patterns loaded from `.nova-data/usage-patterns.json`

---

### `subconscious-reflector` ✅ Wired

**What it does:** Nova's dreaming module. Triggers after 15+ minutes of idle time, then every 30 minutes. Makes LLM calls to analyze recent conversations for patterns, detect contradictions, propose Soul Evolution changes, and run prompt optimization cycles.

**Key exports:** `initReflector()`, `setReflectorLLM()`

**Wiring in daemon.ts:**
- `initReflector()` called at startup
- `setReflectorLLM(state.internalLlm)` for autonomous analysis
- Idle detection via `state.lastActivityTime`

---

### `vibe-regler` ✅ Wired

**What it does:** Time-aware behavioral adjustment. Morning (06:00–09:00): focused and concise. Daytime: normal. Evening (19:00–23:00): relaxed. Night (23:00–06:00): quiet mode (no proactive messages). Idle for 30+ min: minimal mode.

**Key exports:** `initVibeRegler()`, `getCurrentVibe()`

**Wiring in daemon.ts:**
- `initVibeRegler()` called at startup
- Current vibe injected into system prompt and controls proactive behavior

---

### `vram-manager` ✅ Wired

**What it does:** Smart GPU memory management across all nodes. Before loading a new model, checks if VRAM is available. If not, unloads least-recently-used idle models. Coordinates with all Ollama instances in the mesh to maximize GPU utilization.

**Key exports:** `initVRAMManager()`, `ensureVRAMAvailable()`

**Wiring in daemon.ts:**
- `initVRAMManager(ollamaHost)` called with Ollama endpoint from config
- Called before any local model inference request

---

## Summary Table

| Layer | File | Wired | Primary Use |
|-------|------|-------|------------|
| L0 | health-monitor | ✅ | Resource monitoring |
| L0 | self-repair | ✅ | Error recovery |
| L0 | supervisor | ✅ | Response quality + heartbeat |
| L0 | tool-autorepair | ✅ | Tool failure recovery |
| L01 | unified-channels | ✅ | Multi-channel message routing |
| L02 | command-factory | ⚡ | Tool lifecycle management |
| L03 | core-runtime | ✅ | State machine + message bus |
| L04 | secure-auth | ⚡ | Token management |
| L05 | llm-adapters | ⚡ | Provider abstraction |
| L6 | cold-storage | ✅ | USER.md + MEMORY.md |
| L6 | core-facts | ⚡ | Always-on prompt facts |
| L6 | session-summary | ⚡ | Context compression |
| L7 | learning | ✅ | Correction + skill synthesis |
| L7 | tool-learning | ⚡ | Tool pattern learning |
| L8 | meta-learning | ✅ | Capability self-expansion |
| L8 | prisma-guards | ⚡ | DB safety checks |
| L8 | sub-agent | ✅ | Google fallback agent |
| L9 | idle-learning | ✅ | Idle documentation research |
| L10 | vision | ✅ | Screenshot + visual analysis |
| L11 | project-manager | ⚡ | Cross-session project state |
| L12 | anti-hallucination | ✅ | Response validation |
| L12 | qa-agent | ⚡ | Test generation + execution |
| L13 | ast-analyzer | ✅ | Code dependency graph |
| L14 | cost-tracker | ✅ | API cost + budget |
| L15 | security-scanner | ✅ | OWASP security scans |
| L15 | self-check | ✅ | Tool health + self-awareness |
| L16 | business-sense | ✅ | Requirement clarification |
| L17 | autonomous-learning | ✅ | Never-give-up retry loop |
| L18 | llm-router | ✅ | Model selection by task |
| L19 | monitoring | ✅ | URL/service uptime checks |
| L20 | self-improvement | 🔧 | Self-rule synthesis |
| L21 | node-health | ✅ | Cross-node SSH health |
| L22 | federated-memory | ✅ | Cross-node KG sync |
| L23 | instincts | ✅ | Behavioral instinct learning |
| L24 | prompt-optimizer | ✅ | SOUL.md self-optimization |
| — | auto-bug-fix | ✅ | TypeScript build error fix |
| — | dream-daily-digest | ⚡ | Dream cycle consolidation |
| — | memory-distiller | ✅ | Nightly knowledge extraction |
| — | multi-bot | ✅ | Multi-persona management |
| — | multi-user-workers | ✅ | Per-user worker isolation |
| — | predictive-provisioning | ✅ | Model pre-warming |
| — | subconscious-reflector | ✅ | Dreaming + Soul Evolution |
| — | vibe-regler | ✅ | Time-aware behavior |
| — | vram-manager | ✅ | GPU memory management |

**Current runtime: 7 core execution modules · 40 independently wired service modules.**
