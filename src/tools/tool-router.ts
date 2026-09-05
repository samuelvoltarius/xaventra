/**
 * Nova Smart Tool Router
 * 
 * Instead of dumping 112 tools at the LLM, this router selects
 * only the relevant tools based on message context.
 * 
 * Architecture:
 * - CORE tools (~18): Always available — file ops, commands, memory, search
 * - SKILL PACKS: Groups of tools loaded by keyword detection
 * - Nova knows about ALL skill packs and can request them via load_skill_pack
 * 
 * This mirrors how modern AI agents work: base tools + skills loaded on demand.
 */

import { getToolRegistry } from './complete-registry.js'

// ============================================
// Core Tools — ALWAYS sent to LLM
// ============================================

const CORE_TOOLS = new Set([
    // File Operations

    // System
    'get_current_time',

    // Search & Web

    // Memory & Learning
    'kg_search',           // read-only knowledge graph — always useful

    // Communication

    // Subagents — always available, core delegation mechanism

    // Mission

    // Self-Awareness
    'load_skill_pack',
    'nova_capabilities',   // Nova can always query her own tool inventory
    'nova_introspect',     // Nova can always inspect her own state
])

// ============================================
// Skill Packs — loaded on demand by keyword
// ============================================

export interface SkillPack {
    name: string
    description: string
    keywords: string[]
    tools: string[]
}

export function matchesSkillKeyword(message: string, keyword: string): boolean {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu')
        .test(message.toLowerCase())
}

const SKILL_PACKS: SkillPack[] = [
    {
        name: 'files', description: 'Lokale Dateien verwalten',
        keywords: ['datei', 'file', 'ordner', 'verzeichnis', 'lesen', 'schreib', 'pfad'],
        tools: ['desktop_workspace', 'read_file', 'write_file', 'list_directory', 'delete_file', 'send_file'],
    },
    {
        name: 'system-shell', description: 'Befehle und Systemstatus ausführen',
        keywords: ['befehl', 'command', 'shell', 'terminal', 'powershell', 'ssh', 'systemstatus', 'health', 'env'],
        tools: ['run_command', 'ssh_command', 'health_status', 'get_env', 'nova_introspect'],
    },
    {
        name: 'web-search', description: 'Aktuelle Informationen im Web suchen',
        keywords: ['such', 'suche', 'recherch', 'internet', 'web', 'aktuell', 'neueste', 'google', 'url', 'link'],
        tools: ['web_search', 'google_search', 'searxng_search', 'browser_search', 'fetch_url'],
    },
    {
        name: 'personal-memory', description: 'Persönliche Erinnerungen speichern oder abrufen',
        keywords: ['erinnerst', 'erinnerung', 'merk dir', 'merken', 'vergiss', 'memory', 'gedächtnis', 'über mich'],
        tools: ['remember', 'recall', 'update_memory', 'update_user_profile', 'kg_search'],
    },
    {
        name: 'desktop-capture', description: 'Desktop-Screenshot erstellen und senden',
        keywords: ['screenshot', 'screen shot', 'bildschirm', 'desktop', 'screnn shot'],
        tools: ['desktop_screenshot', 'analyze_image', 'send_file'],
    },
    {
        name: 'nova-desktop-control', description: 'Nova Desktop sicher navigieren, fokussieren und aktualisieren',
        keywords: ['nova desktop', 'desktop app', 'desktop-app', 'themenraum', 'nova studio öffnen', 'nova studio oeffnen', 'app fokussieren', 'öffne die nodes', 'oeffne die nodes'],
        tools: ['desktop_control', 'desktop_status', 'desktop_workspace'],
    },
    {
        name: 'bot-management',
        description: 'Telegram/Discord Multi-Bot spawnen, stoppen, auflisten',
        keywords: ['bot', 'telegram', 'spawn', 'kill_bot', 'multi-bot', 'bots'],
        tools: ['spawn_bot', 'kill_bot', 'list_bots'],
    },
    {
        name: 'mesh-network',
        description: 'Edge-Nodes verwalten, deployen, delegieren, Dateien übertragen',
        keywords: ['mesh', 'node', 'edge', 'deploy', 'jetson', 'pi5', 'raspberry', 'delegate'],
        tools: ['mesh_status', 'mesh_nodes', 'mesh_deploy', 'mesh_delegate', 'mesh_update', 'mesh_download_file'],
    },
    {
        name: 'docker',
        description: 'Docker Container und Logs verwalten',
        keywords: ['docker', 'container', 'logs', 'image'],
        tools: ['docker_ps', 'docker_logs'],
    },
    {
        name: 'browser-automation',
        description: 'Headless-Browser steuern: öffnen, klicken, tippen, scrollen, screenshotten, Links extrahieren',
        keywords: ['browser', 'screenshot', 'seite', 'webseite', 'browse', 'scrape', 'extract', 'klick', 'click', 'formular', 'login', 'spa', 'javascript', 'interakt'],
        tools: [
            'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
            'browser_scroll', 'browser_extract', 'browser_screenshot',
            'browser_get_links', 'browser_status', 'browser_close',
            'browser_tab_new', 'browser_tabs', 'browser_tab_switch', 'browser_tab_close',
            'browser_upload', 'browser_download', 'browser_elements', 'browser_handoff', 'browser_replay',
            // legacy
            'browser_screenshot', 'browser_extract',
        ],
    },
    {
        name: 'security',
        description: 'Defensive Blue-Team-Arbeit, Sicherheits-Audits, Log-/IOC-Triage und Incident Response',
        keywords: ['security', 'audit', 'scan', 'port', 'sicherheit', 'netzwerk', 'network', 'blue team', 'blueteam', 'incident', 'ioc', 'siem', 'soc', 'log analyse', 'containment', 'härtung'],
        tools: [
            'security_audit', 'port_scan', 'quick_scan', 'network_info',
            'blue_incident_start', 'blue_asset_inventory', 'blue_log_triage', 'blue_ioc_check',
            'blue_dependency_audit', 'blue_incident_timeline', 'blue_containment_plan',
        ],
    },
    {
        name: 'plugins',
        description: 'Plugins entdecken, laden, verwalten',
        keywords: ['plugin', 'install', 'erweiterung', 'addon'],
        tools: ['discover_plugins', 'load_plugin', 'list_plugins'],
    },
    {
        name: 'voice-media',
        description: 'Text-to-Speech, Audio transkribieren, Stimmen, Bild/Video-Analyse',
        keywords: ['voice', 'speak', 'tts', 'stimme', 'audio', 'transkrib', 'whisper', 'sprach', 'video', 'bild'],
        tools: ['speak', 'list_voices', 'tts_cleanup', 'transcribe_audio', 'analyze_video', 'detect_media', 'generate_image'],
    },
    {
        name: 'image-generation',
        description: 'Bilder aus Textbeschreibungen generieren und senden',
        keywords: ['bild', 'foto', 'illustration', 'bild generieren', 'bild generiere', 'bild erstellen', 'generiere ein bild', 'image generation', 'generate image', 'foto generieren'],
        tools: ['generate_image', 'send_file', 'find_capability', 'resolve_capability', 'nova_capabilities', 'build_skill'],
    },
    {
        name: 'mission-advanced',
        description: 'Mission-Konfiguration, isolierte Workspaces und Sub-Agenten verwalten',
        keywords: ['mission', 'autonom', 'sub-agent', 'agent', 'aufgabe', 'workspace', 'worktree', 'sandbox'],
        tools: ['mission_config', 'list_sub_agents', 'mission_workspace_create', 'mission_workspace_list', 'mission_workspace_diff', 'mission_workspace_run'],
    },
    {
        name: 'hooks-events',
        description: 'Event-Hooks erstellen, verwalten, reagieren',
        keywords: ['hook', 'event', 'trigger', 'automatisch', 'wenn'],
        tools: ['create_hook', 'delete_hook', 'list_hooks', 'hook_history'],
    },
    {
        name: 'polls',
        description: 'Umfragen erstellen und verwalten',
        keywords: ['poll', 'abstimm', 'umfrage', 'voting'],
        tools: ['create_poll', 'vote_poll', 'poll_results'],
    },
    {
        name: 'self-evolution',
        description: 'Neue Tools erstellen, Skills lernen, sich selbst erweitern',
        keywords: ['evolve', 'skill', 'learn', 'tool erstellen', 'neues tool', 'erweit', 'selbst'],
        tools: ['build_skill', 'create_skill', 'load_skills', 'list_custom_tools', 'nova_capabilities'],
    },
    {
        name: 'git-updates',
        description: 'Git-Updates, Versionierung, System-Updates',
        keywords: ['git', 'update', 'version', 'pull', 'push', 'commit'],
        tools: ['pull_update', 'check_updates', 'version_info', 'update_history'],
    },
    {
        name: 'process-management',
        description: 'Prozesse auflisten, beenden, Services verwalten',
        keywords: ['prozess', 'process', 'kill', 'service', 'pid', 'dienst'],
        tools: ['process_list', 'process_kill', 'service_status'],
    },
    {
        name: 'system-config',
        description: 'Model-Override, Quiet-Hours, Tool-Policies, Exec-Rules',
        keywords: ['model', 'override', 'quiet', 'policy', 'config', 'regel', 'einstellung'],
        tools: ['set_model_override', 'set_quiet_hours', 'set_tool_policy', 'list_tool_policies', 'add_exec_rule', 'exec_rules', 'exec_history', 'list_fallback_chains'],
    },
    {
        name: 'advanced-tools',
        description: 'Python ausführen, Base64, Markdown, Disk-Usage, Sessions, Log-Tail',
        keywords: ['python', 'base64', 'markdown', 'disk', 'session', 'log', 'tail', 'compact'],
        tools: ['execute_python', 'file_to_base64', 'parse_markdown', 'markdown_to_whatsapp', 'disk_usage', 'system_info', 'list_sessions', 'tail_log', 'compact_context'],
    },
    {
        name: 'corrections',
        description: 'Korrekturen lernen, Fehler-Patterns merken',
        keywords: ['korrektur', 'correction', 'falsch', 'richtig', 'lern'],
        tools: ['learn_correction'],
    },
    {
        name: 'routing',
        description: 'Kanal-Routing verwalten',
        keywords: ['route', 'routing', 'kanal', 'channel'],
        tools: ['add_route', 'check_command'],
    },
    {
        name: 'self-setup',
        description: 'Self-Setup-Autopilot: Hardware scannen, fehlende Capabilities finden, Aktionen planen und anwenden',
        keywords: ['setup', 'install', 'konfigur', 'einricht', 'capability', 'fehlend', 'missing', 'stt', 'tts', 'whisper', 'ollama', 'ffmpeg', 'embedding', 'vision', 'codex', 'was fehlt', 'was kann ich installier'],
        tools: [
            'codex_install',
            'self_setup_status', 'self_setup_plan', 'self_setup_apply',
            'self_setup_research', 'research_capability_plan', 'research_all_capabilities',
            'resolve_capability', 'find_capability', 'auto_provision',
        ],
    },
    {
        name: 'knowledge-graph',
        description: 'Wissen strukturiert speichern und abrufen: Fakten, Entitäten, Beziehungen im Knowledge Graph',
        keywords: ['wissen', 'knowledge', 'graph', 'fakt', 'entität', 'entity', 'beziehung', 'relation', 'merken', 'kg_', 'wissens'],
        tools: [
            'knowledge_store', 'knowledge_recall', 'knowledge_list',
            'knowledge_get', 'knowledge_delete', 'kg_remember',
        ],
    },
    {
        name: 'llm-management',
        description: 'LLM-Provider registrieren, auflisten, entfernen; Modell-Routing konfigurieren',
        keywords: ['llm', 'provider', 'api key', 'apikey', 'registrier', 'gemini', 'openai', 'deepseek', 'groq', 'mistral', 'kimi', 'minimax', 'model hinzufüg', 'neuen provider', 'together'],
        tools: [
            'register_llm_provider', 'list_llm_providers', 'remove_llm_provider',
            'save_api_key', 'save_config',
        ],
    },
    {
        name: 'code-analysis',
        description: 'Code durchsuchen, Dateien finden, Code-Outline, Code-Items ansehen',
        keywords: ['code', 'funktion', 'klasse', 'class', 'function', 'outline', 'symbol', 'definition', 'referenzen', 'references', 'diagnose', 'diagnostics', 'src/', 'typescript', 'javascript', 'codebase'],
        tools: ['desktop_workspace', 'lsp_query', 'code_search', 'find_files', 'code_outline', 'view_code_item'],
    },
    {
        name: 'developer-harness',
        description: 'Isolierte Code-Ausfuehrung, fortsetzbare Worker und Runtime-Capabilities',
        keywords: ['code ausführen', 'code ausfuehren', 'run code', 'sandbox code', 'fortsetzen', 'resume', 'resume worker', 'subagent fortsetzen', 'agent fortsetzen', 'runtime capability', 'runtime profil'],
        tools: [
            'code_runtime_run', 'continuable_subagent_start', 'continuable_subagent_followup',
            'runtime_capabilities', 'lsp_query',
        ],
    },
    {
        name: 'search-extended',
        description: 'Erweiterte Suchtools: Brave Search API, Tavily Research API',
        keywords: ['brave', 'tavily', 'research search', 'tiefe suche', 'deep search', 'api search'],
        tools: ['brave_search', 'tavily_search'],
    },
    {
        name: 'reminders',
        description: 'Erinnerungen setzen und verwalten',
        keywords: ['erinner', 'reminder', 'alarm', 'notification', 'in 30 min', 'morgen', 'später'],
        tools: ['set_reminder', 'list_reminders'],
    },
    {
        name: 'monitoring',
        description: 'System-Monitoring: Trace-Statistiken, Performance, Nova neu starten oder Status abfragen',
        keywords: ['monitoring', 'performance', 'trace', 'latenz', 'langsam', 'restart', 'neustart', 'nova neu', 'nova status', 'metrics'],
        tools: ['nova_trace_stats', 'nova_restart', 'nova_status', 'list_sessions', 'tail_log'],
    },
    {
        name: 'patch-management',
        description: 'Patch-Proposals verwalten, Selbstreparatur, Skills importieren',
        keywords: ['patch', 'proposal', 'auto_fix', 'reparier', 'self heal', 'import skill', 'fix bug'],
        tools: ['patch_proposals', 'auto_fix', 'import_skill', 'evolution_history', 'evolution_stats'],
    },
    {
        name: 'media-providers',
        description: 'Medienprovider auflisten und konfigurieren (TTS, STT, Image-Gen)',
        keywords: ['provider', 'media provider', 'tts provider', 'stt provider', 'image provider', 'elevenlabs', 'azure'],
        tools: ['list_media_providers'],
    },
]

// ============================================
// Manually loaded skill packs (per session)
// ============================================

const sessionLoadedPacks = new Set<string>()
const MAX_ACTIVE_PACKS = 3
const MAX_WORKER_TOOLS = 24

/**
 * Load a skill pack by name (called by load_skill_pack tool)
 */
export function loadSkillPack(name: string): { loaded: boolean; tools: string[]; error?: string } {
    const pack = SKILL_PACKS.find(p => p.name === name)
    if (!pack) {
        return {
            loaded: false,
            tools: [],
            error: `Skill-Pack "${name}" nicht gefunden. Verfügbare Packs:\n${SKILL_PACKS.map(p => `• ${p.name}: ${p.description}`).join('\n')}`,
        }
    }
    sessionLoadedPacks.add(name)
    return { loaded: true, tools: pack.tools }
}

/**
 * List all available skill packs (for system prompt)
 */
export function getSkillPacksSummary(): string {
    const lines = SKILL_PACKS.map(p => {
        const loaded = sessionLoadedPacks.has(p.name) ? ' ✅' : ''
        return `• **${p.name}**${loaded}: ${p.description} (${p.tools.length} Tools)`
    })
    return lines.join('\n')
}

// ============================================
// Smart Tool Selection
// ============================================

/**
 * Get relevant tools for a given user message.
 * 
 * 1. Always include CORE tools
 * 2. Scan message for skill-pack keywords → include matching packs
 * 3. Include manually loaded packs (session-wide)
 * 4. Return deduplicated tool list
 */
export function getRelevantTools(
    userMessage: string,
    primaryMessage = userMessage,
): ReturnType<ReturnType<typeof getToolRegistry>['getAll']> {
    const registry = getToolRegistry()
    const allTools = registry.getAll()
    const messageLower = userMessage.toLowerCase()
    const primaryLower = primaryMessage.toLowerCase()

    // ── ALL-TOOLS MODE (default) ────────────────────────────────────────────────
    // Modern agentic models (MiniMax-M3, Claude, GPT) with large context windows
    // handle the full tool set well. Filtering to 29/186 was a workaround for weak
    // models — it caused "tool not available" failures (e.g. send_telegram_message
    // missing when the user asked Nova to message someone).
    // Set NOVA_FILTER_TOOLS=1 to re-enable keyword filtering for weak local models.
    if (process.env.NOVA_ALL_TOOLS === '1') {
        // Still exclude embedding/internal-only tools that should never be model-facing
        const excluded = new Set(['embedding', 'internal_only'])
        const usable = allTools.filter(t => !excluded.has(t.name))
        console.log(`[ToolRouter] 📦 ${usable.length}/${allTools.length} tools (all-tools mode)`)
        return usable
    }

    // ── FILTERED MODE (weak models) ─────────────────────────────────────────────
    const includedToolNames = new Set<string>(CORE_TOOLS)

    // The dispatcher selects a small number of packs for this task. A pack
    // loaded in an older turn is only a capability hint, never permission to
    // leak its whole toolset into every future request.
    const rankedPacks = SKILL_PACKS
        .map(pack => ({
            pack,
            primaryScore: pack.keywords.reduce((score, keyword) =>
                score + (matchesSkillKeyword(primaryLower, keyword) ? Math.max(1, keyword.length / 8) : 0), 0),
            contextScore: pack.keywords.reduce((score, keyword) =>
                score + (matchesSkillKeyword(messageLower, keyword) ? Math.max(1, keyword.length / 8) : 0), 0),
        }))
        .filter(candidate => candidate.contextScore > 0 || candidate.primaryScore > 0)
        .sort((a, b) =>
            Number(b.primaryScore > 0) - Number(a.primaryScore > 0)
            || b.primaryScore - a.primaryScore
            || b.contextScore - a.contextScore
            || a.pack.tools.length - b.pack.tools.length)
        .slice(0, MAX_ACTIVE_PACKS)

    const activatedPacks = rankedPacks.map(candidate => candidate.pack.name)
    for (const { pack } of rankedPacks) {
        for (const tool of pack.tools) includedToolNames.add(tool)
    }

    if (activatedPacks.length > 0) {
        console.log(`[ToolRouter] 🎯 Activated packs: ${activatedPacks.join(', ')}`)
    }

    // Current-instruction tools stay ahead of context-only tools. Registry
    // order previously let old conversation packs consume the worker cap and
    // silently evict the tool selected for the current instruction.
    const externalMatches = allTools
        .filter(tool => tool.name.startsWith('mcp__'))
        .map(tool => ({
            tool,
            score: tool.name.split('__').slice(1).reduce((score, token) =>
                score + (token.length > 2 && primaryLower.includes(token.replace(/_/g, ' ')) ? 2 : 0), 0),
        }))
        .filter(candidate => candidate.score > 0 || /\bmcp\b/i.test(primaryMessage))
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, 5)
        .map(candidate => candidate.tool.name)

    const prioritizedNames = [
        ...CORE_TOOLS,
        ...externalMatches,
        ...rankedPacks.flatMap(candidate => candidate.pack.tools),
    ]
    const relevant = [...new Set(prioritizedNames)]
        .filter(name => includedToolNames.has(name))
        .map(name => registry.get(name))
        .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
        .slice(0, MAX_WORKER_TOOLS)
    console.log(`[ToolRouter] 📦 ${relevant.length}/${allTools.length} tools (filtered mode, core: ${CORE_TOOLS.size}, packs: ${activatedPacks.length})`)
    return relevant
}

/**
 * Get a system prompt section explaining available skill packs to Nova
 */
export function getToolRouterPrompt(): string {
    return `
## 🧰 TOOL-SYSTEM (Skill Packs)

Du hast ${CORE_TOOLS.size} Core-Tools immer verfügbar.
Zusätzlich gibt es **Skill-Packs** mit spezialisierten Tools die automatisch geladen werden wenn der Kontext passt.

Falls du ein Tool brauchst das nicht in deiner aktuellen Liste ist, nutze \`load_skill_pack\` um ein Skill-Pack zu laden.
Wenn du nicht weißt welche Tools du für eine Aufgabe hast, nutze \`nova_capabilities\` um dein Tool-Inventar zu durchsuchen.

### Verfügbare Skill-Packs:
${getSkillPacksSummary()}

---

## 🎯 TOOL-ENTSCHEIDUNG — Wann welches Tool?

### 🔍 Web-Suche
| Tool | Wann |
|------|------|
| \`browser_search\` | **Standard.** DuckDuckGo HTML, echte Ergebnisse, kein API-Key |
| \`brave_search\` | Wenn Brave-API-Key vorhanden — qualitativ besser |
| \`tavily_search\` | Wenn tiefe Research-Suche nötig (Tavily-Key) |
| \`google_search\` | Fallback: Google → Startpage → DDG Lite |
| \`web_search\` | Letzter Ausweg. DDG JSON-API, oft sparse |

### 🌐 Seiten lesen
| Tool | Wann |
|------|------|
| \`fetch_url\` | Schnell. Statische Seiten, APIs, Docs, Raw HTML |
| \`browser_open\` | JS-heavy SPAs, Login-Flows, dynamischer Content |

### 🖥️ Browser-Interaktion (erst \`browser_open\`, dann:)
- \`browser_click(selector)\` — Klicken. CSS oder \`text=Weiter\`
- \`browser_type(selector, text)\` — Eingabefeld. Mit \`press_enter: true\` abschicken
- \`browser_extract()\` — Text aus geöffneter Seite lesen (besser als \`fetch_url\` bei SPAs)
- \`browser_screenshot()\` — Screenshot → \`send_file\` an Telegram

### 🧠 Memory & Wissen
| Tool | Wann |
|------|------|
| \`remember\` / \`recall\` | Einfache Key-Value-Erinnerungen |
| \`kg_search\` | Fakten aus dem Knowledge Graph suchen (immer verfügbar) |
| \`kg_remember\` | Fakt als Tripel speichern: Subjekt → Relation → Objekt |
| \`knowledge_store\` / \`knowledge_recall\` | Strukturiertes Wissen mit Metadaten |

### 🤖 Subagenten & Delegation
| Tool | Wann |
|------|------|
| \`spawn_subagent\` | Einzelne fokussierte Teilaufgabe auslagern |
| \`spawn_subagents_parallel\` | Mehrere unabhängige Aufgaben gleichzeitig |
| \`ssh_command\` | Direktes Kommando auf Mesh-Node |
| \`mesh_delegate\` | Aufgabe an besten verfügbaren Node delegieren |

### 📁 Dateien & Code
| Tool | Wann |
|------|------|
| \`read_file\` / \`write_file\` | Lokale Dateien |
| \`code_search\` | Code nach Pattern durchsuchen (ripgrep-basiert) |
| \`find_files\` | Dateien nach Name/Pattern finden |
| \`code_outline\` | Struktur einer Datei (Funktionen, Klassen) |
| \`view_code_item\` | Einzelne Funktion/Klasse im Detail lesen |

### 🔧 Self-Setup & Capabilities
| Tool | Wann |
|------|------|
| \`self_setup_plan\` | Was fehlt auf diesem System? |
| \`self_setup_research\` | Aktuelle Web-Recherche für fehlende Capabilities |
| \`self_setup_apply\` | Eine konkrete Action ausführen |
| \`resolve_capability\` | Brauche Tool X — finde & installiere es |

### 🔬 Monitoring & Diagnose
| Tool | Wann |
|------|------|
| \`nova_trace_stats\` | Performance-Analyse: langsame Tools, Fehlerquoten |
| \`nova_introspect\` | Eigenen Zustand, Ziele, Skills, System-Prompt |
| \`nova_capabilities\` | Welche Tools habe ich für Thema X? |
| \`health_status\` | Schneller System-Überblick |

### 🎙️ Medien
| Tool | Wann |
|------|------|
| \`speak\` | Text vorlesen (TTS) |
| \`transcribe_audio\` | Audio/Voice-Nachricht → Text |
| \`analyze_image\` | Bild analysieren/beschreiben |
| \`generate_image\` | Bild generieren |
| \`analyze_video\` | Video analysieren |

**WICHTIGE REGELN:**
- Rufe Tools DIREKT auf — beschreibe sie nicht nur
- Unsicher welches Tool? → \`nova_capabilities('suchbegriff')\`
- Tool nicht in Liste? → \`load_skill_pack('pack-name')\`
- Parallele unabhängige Aufgaben → immer \`spawn_subagents_parallel\`
`
}

// ============================================
// The load_skill_pack Tool Definition
// ============================================

export const loadSkillPackTool = {
    name: 'load_skill_pack',
    description: 'Lädt ein Skill-Pack mit spezialisierten Tools. Nutze das wenn du ein Tool brauchst das nicht in deiner aktuellen Liste ist. Ohne Argument: zeigt alle verfügbaren Packs.',
    category: 'system' as const,
    parameters: [
        { name: 'pack_name', type: 'string' as const, description: 'Name des Skill-Packs (z.B. bot-management, mesh-network, docker, voice-media, security, self-evolution)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const name = params.pack_name as string
        if (!name) {
            return `📦 Verfügbare Skill-Packs:\n\n${getSkillPacksSummary()}\n\nNutze \`load_skill_pack\` mit dem Pack-Namen um Tools zu laden.`
        }
        const result = loadSkillPack(name)
        if (result.error) return result.error
        return `✅ Skill-Pack "${name}" geladen!\n\nNeue Tools verfügbar:\n${result.tools.map(t => `• ${t}`).join('\n')}\n\nDiese Tools sind jetzt für den Rest der Session verfügbar.`
    },
}
