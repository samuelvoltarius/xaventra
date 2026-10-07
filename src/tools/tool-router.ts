/**
 * Xaventra Tool Router
 *
 * Picks the tools offered to the model for one request. Every registered tool
 * has at least one way to the model (2.89, invariant test in
 * tool-router-reachability.test.ts):
 * - CORE tools: always offered.
 * - FALLBACK: load_skill_pack only when nothing else matched.
 * - SKILL PACKS: offered when a keyword of the pack appears in the request.
 * - LIVE ROUTES: dedicated patterns for plain-word requests (VMs, parcels,
 *   connecting services, password vault, mesh, environment).
 * - DYNAMIC tools (MCP `mcp__*`, forge `forge_*`, plugin tools): offered when
 *   their name or description words appear in the request.
 * - On demand: `load_skill_pack` loads a pack into the RUNNING request, and a
 *   call to a registered but not offered tool is admitted by the runner when
 *   role and policy allow it (agents/tool-admission.ts).
 *
 * Mode: the filtered mode is the default. `NOVA_ALL_TOOLS=1` offers every
 * registered tool at once (large-context models only); there is no other
 * switch.
 */

import { getToolRegistry } from './complete-registry.js'
import { detectActionIntent, type ActionIntent } from '../core/action-intent.js'
import { isDirectUrlCheck } from '../core/tool-evidence-binding.js'
import { containsTailnetUrl, isNodeScreenshotRequest, mentionsMesh, mentionsEnvironment } from '../core/request-capabilities.js'

// ============================================
// Core Tools — ALWAYS sent to the model
// ============================================

const CORE_TOOLS = new Set([
    'get_current_time',
    'kg_search',           // read-only knowledge graph — always useful
    'nova_capabilities',   // own tool inventory
    'nova_introspect',     // own state
])

// 2.89: load_skill_pack is no core tool any more — live it burned rounds
// („load_skill_pack“ twice, then Max turns). Tools now join the running
// request automatically (a call to a registered tool is admitted); the loader
// is offered only when nothing matched the request at all.
const FALLBACK_TOOLS = ['load_skill_pack'] as const

// ============================================
// Keywords
// ============================================

/**
 * A pack keyword is
 * - a plain word or phrase: matched as a whole word (`kill` never matches `skill`),
 * - `stem*`: a word starting with the stem (`erinner*` → „Erinnere“, „erinnern“),
 * - `*tail`: a word ending in the tail, for German compounds (`*lampe` →
 *   „Deckenlampe“), with an optional inflection ending,
 * - a RegExp for anything else.
 */
export type SkillKeyword = string | RegExp

export interface SkillPack {
    name: string
    description: string
    keywords: SkillKeyword[]
    tools: string[]
}

const NOT_WORD = '[^\\p{L}\\p{N}_]'
const keywordCache = new Map<string, RegExp>()

function keywordPattern(keyword: string): RegExp {
    const cached = keywordCache.get(keyword)
    if (cached) return cached
    const lower = keyword.toLowerCase()
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let source: string
    if (lower.length > 1 && lower.endsWith('*')) {
        source = `(^|${NOT_WORD})${escape(lower.slice(0, -1))}`
    } else if (lower.length > 1 && lower.startsWith('*')) {
        source = `(^|${NOT_WORD})\\p{L}*${escape(lower.slice(1))}(e|en|er|n|s)?(${NOT_WORD}|$)`
    } else {
        source = `(^|${NOT_WORD})${escape(lower)}(${NOT_WORD}|$)`
    }
    const pattern = new RegExp(source, 'iu')
    keywordCache.set(keyword, pattern)
    return pattern
}

export function matchesSkillKeyword(message: string, keyword: SkillKeyword): boolean {
    if (keyword instanceof RegExp) return keyword.test(message)
    return keywordPattern(keyword).test(message.toLowerCase())
}

function keywordWeight(keyword: SkillKeyword): number {
    if (keyword instanceof RegExp) return 1.5
    return Math.max(1, keyword.replace(/\*/g, '').length / 8)
}

// „Licht“ also inside a compound („Wohnzimmerlicht“), but not „Pflicht“/„verpflichtet“.
const LIGHT_COMPOUND = /(^|[^\p{L}\p{N}_])\p{L}*(?<!pf)licht(er|ern)?([^\p{L}\p{N}_]|$)/iu
// „in 10 Minuten“, „in einer Stunde“, „um 7 Uhr“.
const TIME_SPAN = /(^|[^\p{L}\p{N}_])(in|nach)\s+(\d+|einer|einem|zwei|drei|fünf|zehn|zwanzig|dreißig|einer halben)\s*(sek|min|std|stunde|tag)\p{L}*|(^|[^\p{L}\p{N}_])um\s+\d{1,2}([:.]\d{2})?\s*uhr([^\p{L}\p{N}_]|$)/iu

// Separable German verbs: „Richte die Spracheingabe ein“, „Stell das Mikro ein“.
const SEPARABLE_SETUP = /(^|[^\p{L}\p{N}_])(richte|richtet|stell|stelle)\s.{0,60}\sein([^\p{L}\p{N}_]|$)/iu

const SKILL_PACKS: SkillPack[] = [
    {
        name: 'files', description: 'Lokale Dateien verwalten',
        keywords: ['datei*', 'file', 'files', 'ordner*', 'verzeichnis*', 'lesen', 'lies', 'schreib', 'pfad*'],
        tools: ['desktop_workspace', 'read_file', 'find_files', 'write_file', 'list_directory', 'delete_file', 'send_file', 'file_to_base64'],
    },
    {
        name: 'documents', description: 'Dokumente (PDF, Word, Excel, Rechnungen, Verträge) lesen und auswerten',
        keywords: ['dokument*', 'pdf', 'pdfs', 'docx', 'word', 'excel', 'xlsx', 'tabelle*', 'rechnung*', 'vertrag', 'verträge', 'vertrags*', 'brief'],
        tools: ['read_document', 'read_file', 'parse_markdown', 'find_files'],
    },
    {
        name: 'system-shell', description: 'Befehle und Systemstatus ausführen',
        keywords: ['befehl*', 'command', 'shell', 'terminal', 'powershell', 'bash', 'ssh', 'systemstatus', 'health', 'env', 'umgebungsvariable*'],
        tools: ['run_command', 'ssh_command', 'health_status', 'get_env', 'nova_introspect', 'system_info'],
    },
    {
        name: 'web-search', description: 'Aktuelle Informationen im Web suchen',
        keywords: ['such*', 'recherch*', 'internet', 'web', 'google', 'googel*', 'url', 'neueste*', 'nachschlagen'],
        tools: ['web_search', 'google_search', 'searxng_search', 'browser_search', 'fetch_url'],
    },
    {
        // 2.87.1: without this pack Home Assistant / light questions reached the model with
        // the 5 core tools only (live 07.10.). 2.89: stems and compounds instead of whole words.
        name: 'smart-home', description: 'Home Assistant: Licht, Heizung, Thermostat, Rollo, Szenen, Steckdosen und Sensoren lesen oder schalten',
        keywords: ['home assistant', 'homeassistant', 'homeassist', 'homeassit', 'homeasistant', 'home-assistant', 'hass', 'smart home', 'smarthome',
            LIGHT_COMPOUND, '*lampe', '*leuchte', 'steckdose*', '*steckdose', 'heiz*', '*heizung', 'thermostat*', 'sensor*', '*sensor',
            'hue', 'tuya', 'rollo*', '*rollo', 'rollladen', 'rolladen', 'jalousie*', 'szene*', 'temperatur*', '*temperatur', 'klima*', 'grad',
            'wärmer', 'kälter', 'waermer', 'kaelter', 'ventilator', 'dimm*', 'schalte', 'einschalten', 'ausschalten', 'wohnzimmer', 'schlafzimmer'],
        tools: ['hass_status', 'hass_list', 'hass_get', 'hass_turn_on', 'hass_turn_off', 'hass_toggle', 'hass_service', 'environment_inventory'],
    },
    {
        name: 'printer', description: 'Drucker und 3D-Druck: Status, Dateien, Slicen, Druck starten/pausieren, CAD-Modelle erzeugen',
        keywords: ['druck*', '3d-druck*', '3d druck', '*drucker', 'filament*', 'slice*', 'slicer', 'gcode', 'g-code', 'stl', 'cad',
            'klipper', 'moonraker', 'bambu', 'creality', 'prusa', 'düse', 'nozzle'],
        tools: ['printer_status', 'printer_info', 'printer_files', 'printer_discover', 'printer_slice', 'printer_print', 'printer_start',
            'printer_pause', 'printer_resume', 'printer_cancel', 'printer_gcode', 'cad_generate'],
    },
    {
        name: 'vision-camera', description: 'Kamera, Bildschirm und Bilder ansehen: Webcam-Bild, Gesichter, Gesten, Bildanalyse',
        keywords: ['kamera*', '*kamera', 'webcam*', 'gesicht*', 'geste*', 'handzeichen', 'vision', 'was siehst', 'sieh dir', 'schau dir', 'erkennst du', 'analysier*'],
        tools: ['webcam_capture', 'screen_capture', 'screen_analyze', 'face_detect', 'hand_gesture', 'analyze_image', 'minimax_vision'],
    },
    {
        name: 'personal-memory', description: 'Persönliche Erinnerungen speichern oder abrufen, etwas lernen',
        keywords: ['erinnerst', 'erinnerung*', 'merk dir', 'merke', 'merken', 'vergiss', 'memory', 'gedächtnis', 'über mich', 'lern*', 'weißt du noch', 'notier*'],
        tools: ['remember', 'recall', 'update_memory', 'update_user_profile', 'kg_search', 'kg_remember'],
    },
    {
        name: 'messages', description: 'Nachrichten verschicken (Telegram) und Dateien zustellen',
        keywords: ['telegram', 'nachricht*', 'benachrichtig*', 'message', 'sms', 'schreib ihm', 'schreib ihr'],
        tools: ['send_telegram_message', 'send_file'],
    },
    {
        name: 'subagents', description: 'Helfer (Sub-Agenten) starten, auch mehrere parallel, auflisten und unterbrechen',
        keywords: ['helfer*', 'parallel*', 'subagent*', 'sub-agent*', 'gleichzeitig', 'delegier*', 'teilaufgabe*', 'agenten', 'agent', 'team'],
        tools: ['spawn_subagent', 'spawn_subagents_parallel', 'list_subagents', 'subagent_interrupt', 'list_sub_agents',
            'continuable_subagent_start', 'continuable_subagent_followup'],
    },
    {
        name: 'projects', description: 'Eigene Projekte und laufende Missionen: Stand abfragen, neue starten',
        keywords: ['projekt*', '*projekt', '*projekte', 'kümmer*', 'kuemmer*', 'wie steht', 'stand der dinge', 'nebenbei'],
        tools: ['projekte_status', 'mission_status', 'start_mission'],
    },
    {
        name: 'self-doctor', description: 'Selbstdiagnose: was ist kaputt, Befunde ansehen und abhaken',
        keywords: ['doctor', 'doktor', 'diagnos*', 'selbsttest', 'selbstdiagnose', 'kaputt', 'funktioniert nicht', 'geht nicht', 'befund*', 'prüf dich', 'check dich', 'fehlersuche'],
        tools: ['self_doctor', 'self_doctor_findings', 'self_doctor_update_finding', 'health_status', 'nova_status'],
    },
    {
        name: 'desktop-capture', description: 'Desktop-Screenshot erstellen und senden',
        keywords: ['screenshot*', 'screen shot', 'bildschirm*', 'desktop', 'screnn shot'],
        // No generic send_file here: desktop_screenshot delivers its own image
        // to the authenticated requester; send_file would let the model pick files.
        tools: ['desktop_screenshot', 'desktop_input', 'analyze_image'],
    },
    {
        name: 'computer-use', description: 'Freigegebenen Desktop per Screenshot, Maus und Tastatur bedienen',
        keywords: ['computer use', 'computer-use', 'maus', 'tastatur', 'klicken', 'klick', 'tippe', 'scroll'],
        tools: ['desktop_screenshot', 'desktop_input'],
    },
    {
        name: 'nova-desktop-control', description: 'Nova Desktop sicher navigieren, fokussieren und aktualisieren',
        keywords: ['nova desktop', 'desktop app', 'desktop-app', 'themenraum', 'nova studio öffnen', 'nova studio oeffnen', 'app fokussieren', 'öffne die nodes', 'oeffne die nodes'],
        tools: ['desktop_control', 'desktop_status', 'desktop_workspace'],
    },
    {
        name: 'mesh-network',
        description: 'Edge-Nodes verwalten, deployen, delegieren, Dateien übertragen',
        keywords: ['mesh', 'node', 'nodes', 'knoten*', 'edge', 'deploy*', 'jetson', 'pi5', 'raspberry', 'delegate'],
        tools: ['mesh_status', 'mesh_nodes', 'mesh_services', 'mesh_strengths', 'mesh_capabilities', 'mesh_route', 'mesh_repo_task', 'mesh_deploy', 'mesh_delegate',
            'mesh_update', 'mesh_download_file', 'mesh_exchange_list', 'mesh_exchange_write', 'mesh_exchange_send', 'mesh_screenshot',
            'mesh_scan', 'mesh_recommendations', 'mesh_transport_status', 'mesh_inspect_url'],
    },
    {
        name: 'docker',
        description: 'Docker Container und Logs verwalten',
        keywords: ['docker', 'container*', 'logs', 'image'],
        tools: ['docker_ps', 'docker_logs', 'docker_status', 'docker_control'],
    },
    {
        name: 'browser-automation',
        description: 'Headless-Browser steuern: öffnen, klicken, tippen, scrollen, screenshotten, Links extrahieren',
        keywords: ['browser*', 'screenshot', 'seite', 'webseite*', 'browse', 'scrape', 'extract', 'klick', 'click', 'formular', 'login', 'spa', 'javascript', 'interakt*'],
        tools: [
            'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
            'browser_scroll', 'browser_extract', 'browser_screenshot',
            'browser_get_links', 'browser_status', 'browser_close',
            'browser_tab_new', 'browser_tabs', 'browser_tab_switch', 'browser_tab_close',
            'browser_upload', 'browser_download', 'browser_elements', 'browser_handoff', 'browser_replay',
        ],
    },
    {
        name: 'security',
        description: 'Defensive Blue-Team-Arbeit, Sicherheits-Audits, Log-/IOC-Triage und Incident Response',
        keywords: ['security', 'audit', 'scan', 'port', 'sicherheit*', 'netzwerk*', 'network', 'blue team', 'blueteam', 'incident', 'ioc', 'siem', 'soc', 'log analyse', 'containment', 'härtung'],
        tools: [
            'security_audit', 'port_scan', 'quick_scan', 'network_info',
            'blue_incident_start', 'blue_asset_inventory', 'blue_log_triage', 'blue_ioc_check',
            'blue_dependency_audit', 'blue_incident_timeline', 'blue_containment_plan',
        ],
    },
    {
        name: 'plugins',
        description: 'Plugins entdecken, laden, verwalten',
        keywords: ['plugin*', 'install', 'erweiterung*', 'addon*'],
        tools: ['discover_plugins', 'load_plugin', 'list_plugins'],
    },
    {
        name: 'voice-media',
        description: 'Text-to-Speech, Audio transkribieren, Stimmen, Video-Analyse',
        keywords: ['voice', 'speak', 'tts', 'stimme*', 'audio', 'transkrib*', 'whisper', 'sprachnachricht*', 'sprachausgabe', 'spracheingabe', 'sprachsteuerung', 'mikrofon*', 'vorles*', 'lies vor', 'video*', '*video'],
        tools: ['speak', 'list_voices', 'tts_cleanup', 'voice_setup', 'transcribe_audio', 'analyze_video', 'detect_media',
            'minimax_tts', 'minimax_video_start', 'minimax_video_status'],
    },
    {
        name: 'image-generation',
        description: 'Bilder aus Textbeschreibungen generieren und senden',
        keywords: ['bild generier*', 'bild erstell*', 'generiere ein bild', 'erstelle ein bild', 'image generation', 'generate image',
            'foto generier*', 'illustration*', 'zeichne*', 'mal mir'],
        tools: ['generate_image', 'minimax_image_gen', 'send_file', 'find_capability', 'resolve_capability', 'nova_capabilities', 'build_skill'],
    },
    {
        name: 'mission-advanced',
        description: 'Missionen starten und konfigurieren, isolierte Workspaces',
        keywords: ['mission*', 'autonom*', 'workspace', 'worktree', 'sandbox', 'langfrist*'],
        tools: ['start_mission', 'mission_status', 'mission_config', 'mission_workspace_create', 'mission_workspace_list', 'mission_workspace_diff', 'mission_workspace_run'],
    },
    {
        name: 'hooks-events',
        description: 'Event-Hooks erstellen, verwalten, reagieren',
        keywords: ['hook*', 'event', 'events', 'trigger*', 'automatisch'],
        tools: ['create_hook', 'delete_hook', 'list_hooks', 'hook_history'],
    },
    {
        name: 'polls',
        description: 'Umfragen erstellen und verwalten',
        keywords: ['poll', 'abstimm*', 'umfrage*', 'voting'],
        tools: ['create_poll', 'vote_poll', 'poll_results'],
    },
    {
        name: 'self-evolution',
        description: 'Neue Werkzeuge bauen (Werkzeug-Schmiede), Skills laden, sich selbst erweitern',
        keywords: ['evolve', 'skill*', 'learn', 'tool erstellen', 'neues tool', 'neues werkzeug', 'werkzeug bau*', 'erweiter*', 'schmiede', 'bau dir'],
        tools: ['build_skill', 'create_skill', 'delete_skill', 'load_skills', 'list_skills', 'import_skill', 'nova_capabilities'],
    },
    {
        name: 'git-updates',
        description: 'Git-Updates, Versionierung, System-Updates',
        keywords: ['git', 'pull', 'push', 'commit', 'updaten', 'aktualisier*', 'gibt es ein update', 'neue version', 'welche version', 'updates', 'release'],
        tools: ['pull_update', 'check_updates', 'version_info', 'update_history', 'mesh_update'],
    },
    {
        name: 'process-management',
        description: 'Prozesse auflisten, beenden, Services verwalten',
        keywords: ['prozess*', 'process', 'kill', 'service', 'pid', 'dienst', 'dienste'],
        tools: ['process_list', 'process_kill', 'service_status'],
    },
    {
        name: 'system-config',
        description: 'Model-Override, Ruhezeiten, Tool-Policies, Exec-Rules',
        keywords: ['model', 'override', 'quiet', 'ruhezeit*', 'nicht stören', 'policy', 'config', 'regel', 'regeln', 'einstellung*', 'fallback'],
        tools: ['set_model_override', 'set_quiet_hours', 'set_tool_policy', 'list_tool_policies', 'add_exec_rule', 'exec_rules', 'exec_history', 'list_fallback_chains', 'check_command'],
    },
    {
        name: 'advanced-tools',
        description: 'Python ausführen, Base64, Markdown, Disk-Usage, Sessions, Log-Tail',
        keywords: ['python', 'base64', 'markdown', 'disk', 'festplatte*', 'speicherplatz', 'session', 'log', 'tail', 'compact'],
        tools: ['execute_python', 'file_to_base64', 'parse_markdown', 'markdown_to_whatsapp', 'disk_usage', 'system_info', 'list_sessions', 'tail_log', 'compact_context'],
    },
    {
        name: 'corrections',
        description: 'Korrekturen lernen, Fehler-Patterns merken',
        keywords: ['korrektur*', 'correction', 'lern*', 'stimmt nicht', 'das war falsch', 'falsch verstanden'],
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
        keywords: ['setup', 'install', 'installier*', 'konfigur*', 'einricht*', SEPARABLE_SETUP, 'capability', 'fehlend*', 'missing', 'stt', 'tts', 'whisper', 'ollama', 'ffmpeg', 'embedding', 'vision', 'codex', 'was fehlt', 'was kann ich installier*'],
        tools: [
            'codex_install',
            'self_setup_status', 'self_setup_plan', 'self_setup_apply',
            'self_setup_research', 'research_capability_plan', 'research_all_capabilities',
            'resolve_capability', 'find_capability', 'auto_provision', 'voice_setup',
        ],
    },
    {
        name: 'knowledge-graph',
        description: 'Wissen strukturiert speichern und abrufen: Fakten, Entitäten, Beziehungen im Knowledge Graph',
        keywords: ['wissen*', 'knowledge', 'graph', 'fakt*', 'entität*', 'entity', 'beziehung*', 'relation', 'merken', 'kg_'],
        tools: [
            'knowledge_store', 'knowledge_recall', 'knowledge_list',
            'knowledge_get', 'knowledge_delete', 'kg_remember',
        ],
    },
    {
        name: 'llm-management',
        description: 'LLM-Provider registrieren, auflisten, entfernen; Modell-Routing konfigurieren',
        keywords: ['llm', 'provider', 'api key', 'apikey', 'registrier*', 'gemini', 'openai', 'deepseek', 'groq', 'mistral', 'kimi', 'minimax', 'model hinzufüg*', 'neuen provider', 'together'],
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
        description: 'Erinnerungen und Wecker setzen und verwalten',
        keywords: ['erinner*', 'reminder*', 'alarm', 'wecker', 'weck mich', 'timer', 'notification', 'später', TIME_SPAN],
        tools: ['set_reminder', 'list_reminders'],
    },
    {
        name: 'monitoring',
        description: 'System-Monitoring: Trace-Statistiken, Performance, Nova neu starten oder Status abfragen',
        keywords: ['monitoring', 'performance', 'trace', 'latenz', 'langsam', 'restart', 'neustart*', 'nova neu', 'nova status', 'metrics'],
        tools: ['nova_trace_stats', 'nova_restart', 'nova_status', 'list_sessions', 'tail_log'],
    },
    {
        name: 'patch-management',
        description: 'Patch-Vorschläge (PATCH_GATE), Selbstreparatur, Skills importieren',
        keywords: ['patch*', 'proposal', 'auto_fix', 'reparier*', 'self heal', 'import skill', 'fix bug', 'selbstverbesser*'],
        tools: ['patch_proposals', 'auto_fix', 'import_skill', 'evolution_history', 'evolution_stats', 'self_evolve', 'evolve_self'],
    },
    {
        name: 'media-providers',
        description: 'Medienprovider auflisten und konfigurieren (TTS, STT, Image-Gen)',
        keywords: ['provider', 'media provider', 'tts provider', 'stt provider', 'image provider', 'elevenlabs', 'azure'],
        tools: ['list_media_providers'],
    },
]

// ============================================
// Live routes — dedicated plain-word patterns
// ============================================

interface LiveRoute {
    name: string
    tools: readonly string[]
    applies: (primaryMessage: string, intent: ActionIntent) => boolean
}

const LIVE_ROUTES: readonly LiveRoute[] = [
    { name: 'mesh', tools: ['mesh_status', 'mesh_nodes', 'mesh_strengths'], applies: text => mentionsMesh(text) },
    { name: 'environment', tools: ['environment_inventory', 'scan_now', 'mesh_services', 'mesh_status', 'mesh_nodes'], applies: text => mentionsEnvironment(text) },
    { name: 'parcel', tools: ['parcel_track'], applies: text => /\b(paket|sendung|trackingnummer|tracking|parcel|shipment|dhl|17track)\b/i.test(text) },
    // 2.88: plain words instead of slash commands (VMs, connecting services, the password vault).
    { name: 'proxmox', tools: ['proxmox_vm'], applies: text => /\b(proxmox|vms?|snapshots?|virtuelle\w*)\b|-vm\b/i.test(text) },
    { name: 'connect', tools: ['dienst_finden', 'dienst_verbinden'], applies: text => /\b(verbind\w*|anbind\w*|connect\w*)\b/i.test(text) },
    { name: 'vault', tools: ['zugaenge_liste', 'anmelden_mit_zugang', 'zugang_freigabe_anfragen'],
        applies: text => /\b(passw(?:o|ö)rt\w*|zug(?:a|ä)ng\w*|tresor|anmeld\w*|einlogg\w*|login)\b|melde dich/i.test(text) },
    { name: 'tailnet', tools: ['mesh_inspect_url', 'mesh_services'], applies: text => containsTailnetUrl(text) },
    { name: 'screenshot', tools: ['desktop_screenshot'], applies: (_text, intent) => intent.kind === 'screenshot' },
]

/** Tools a route must never offer, even when another pack lists them. */
function routeExclusions(primaryMessage: string, intent: ActionIntent): Set<string> {
    const excluded = new Set<string>()
    // desktop_screenshot delivers its own picture to the authenticated
    // requester; a generic send_file would let the model pick any file.
    const capture = intent.kind === 'screenshot' || SKILL_PACKS.some(pack => (pack.name === 'desktop-capture' || pack.name === 'computer-use')
        && pack.keywords.some(keyword => matchesSkillKeyword(primaryMessage, keyword)))
    if (capture) excluded.add('send_file')
    return excluded
}

// ============================================
// Reachability (invariant: every registered tool has a way)
// ============================================

const DYNAMIC_PREFIXES = ['mcp__', 'forge_'] as const

/**
 * The static way of a tool to the model ('core', 'pack:<name>', 'live:<name>'),
 * 'dynamic' for MCP/forge tools (reached by name/description words), or null.
 * Plugin tools are registered at runtime and also reached by name/description;
 * every built-in tool must have a static way.
 */
export function toolRoute(name: string): string | null {
    if (CORE_TOOLS.has(name)) return 'core'
    if ((FALLBACK_TOOLS as readonly string[]).includes(name)) return 'fallback'
    const pack = SKILL_PACKS.find(item => item.tools.includes(name))
    if (pack) return `pack:${pack.name}`
    const live = LIVE_ROUTES.find(route => route.tools.includes(name))
    if (live) return `live:${live.name}`
    if (DYNAMIC_PREFIXES.some(prefix => name.startsWith(prefix))) return 'dynamic'
    return null
}

const STATICALLY_ROUTED = new Set<string>([...CORE_TOOLS, ...FALLBACK_TOOLS, ...SKILL_PACKS.flatMap(pack => pack.tools), ...LIVE_ROUTES.flatMap(route => route.tools)])

/** Every tool name the router names statically (core, packs, live routes). */
export function routedToolNames(): string[] { return [...STATICALLY_ROUTED] }

/**
 * Whether the run of this request may load further tools on demand
 * (load_skill_pack, or a call to a registered tool that was not offered), and
 * which tools stay excluded. Node screenshots and direct URL checks keep their
 * fixed source-bound contract.
 */
export function toolExpansionPolicy(primaryMessage: string): { sealed: boolean; excluded: ReadonlySet<string> } {
    if (isNodeScreenshotRequest(primaryMessage) || isDirectUrlCheck(primaryMessage)) return { sealed: true, excluded: new Set() }
    return { sealed: false, excluded: routeExclusions(primaryMessage, detectActionIntent(primaryMessage)) }
}

// ============================================
// Skill packs on demand
// ============================================

const sessionLoadedPacks = new Set<string>()
// 2.89: 3 packs / 24 tools let a context pack evict the relevant one. The
// best pack of the current instruction is now always complete (see ordering).
const MAX_ACTIVE_PACKS = 4
const MAX_WORKER_TOOLS = 40

/** Reviewed aliases only; never derive tools from arbitrary text. */
const PACK_ALIASES: Readonly<Record<string, string>> = {
    web: 'web-search', 'home-assistant': 'smart-home', homeassistant: 'smart-home', drucker: 'printer', kamera: 'vision-camera',
    dokumente: 'documents', projekte: 'projects', nachrichten: 'messages', missionen: 'mission-advanced', helfer: 'subagents',
}

/**
 * Resolve a skill pack by name. load_skill_pack calls this; the runner then
 * admits the tools into the running request (agents/tool-admission.ts).
 */
export function loadSkillPack(name: string): { loaded: boolean; tools: string[]; name?: string; error?: string } {
    const canonicalName = PACK_ALIASES[name] || name
    const pack = SKILL_PACKS.find(p => p.name === canonicalName)
    if (!pack) {
        return {
            loaded: false,
            tools: [],
            error: `Skill-Pack "${name}" nicht gefunden. Verfügbare Packs:\n${SKILL_PACKS.map(p => `• ${p.name}: ${p.description}`).join('\n')}`,
        }
    }
    sessionLoadedPacks.add(pack.name)
    return { loaded: true, tools: [...pack.tools], name: pack.name }
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

type RegisteredTool = ReturnType<ReturnType<typeof getToolRegistry>['getAll']>[number]

function dynamicMatches(allTools: readonly RegisteredTool[], primaryMessage: string): string[] {
    const primaryLower = primaryMessage.toLowerCase()
    // MCP tools: server/tool name tokens, or the word „mcp“.
    const external = allTools
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
    // Forge tools (Werkzeug-Schmiede) and plugin tools — everything registered
    // without a static way: name or description words in the instruction.
    const described = allTools
        .filter(tool => !tool.name.startsWith('mcp__') && !STATICALLY_ROUTED.has(tool.name))
        .map(tool => ({
            tool,
            score: [...tool.name.replace(/^forge_/, '').split('_'), ...String(tool.description || '').replace(/^\[[^\]]*\]\s*/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)]
                .filter(token => token.length > 3)
                .reduce((score, token) => score + (primaryLower.includes(token) ? 1 : 0), 0),
        }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, 5)
        .map(candidate => candidate.tool.name)
    return [...external, ...described]
}

/**
 * Get relevant tools for a given user message.
 *
 * 1. CORE tools
 * 2. Explicitly named registered tools, then live routes
 * 3. Packs matching the current instruction (the best one always complete)
 * 4. MCP / forge / plugin tools by name and description words
 * 5. Packs seen only in older conversation context fill the remaining room
 */
export function getRelevantTools(
    userMessage: string,
    primaryMessage = userMessage,
): RegisteredTool[] {
    const registry = getToolRegistry()
    const allTools = registry.getAll()
    const primaryIntent = detectActionIntent(primaryMessage)

    // Only the source-bound capture protocol may fulfill a node screenshot.
    if (isNodeScreenshotRequest(primaryMessage)) {
        return [...CORE_TOOLS, 'mesh_status', 'mesh_nodes', 'mesh_services', 'mesh_screenshot'].map(name => registry.get(name))
            .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    }

    // Checking a concrete endpoint is not a search for pages about that URL.
    // Keep the exact fetch inside the original immutable contract, including in
    // all-tools mode. No fabricated search receipt or relaxed target validator.
    if (isDirectUrlCheck(primaryMessage)) {
        const urlTools = containsTailnetUrl(primaryMessage) ? ['mesh_inspect_url', 'mesh_nodes', 'mesh_services'] : ['fetch_url']
        return [...CORE_TOOLS, ...urlTools].map(name => registry.get(name))
            .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
    }

    // ── ALL-TOOLS MODE (opt-in) ─────────────────────────────────────────────
    // NOVA_ALL_TOOLS=1 offers every registered tool (large-context models).
    // The filtered mode below is the default; no other variable switches it.
    if (process.env.NOVA_ALL_TOOLS === '1') {
        const internal = new Set(['embedding', 'internal_only'])
        const usable = allTools.filter(t => !internal.has(t.name))
        console.log(`[ToolRouter] 📦 ${usable.length}/${allTools.length} tools (all-tools mode)`)
        return usable
    }

    // ── FILTERED MODE (default) ─────────────────────────────────────────────
    const excluded = routeExclusions(primaryMessage, primaryIntent)
    const liveTools = LIVE_ROUTES.filter(route => route.applies(primaryMessage, primaryIntent)).flatMap(route => route.tools)

    // An explicit registered tool identifier is stronger than a fuzzy pack
    // keyword (`health_status` must not need the pack keyword `health`).
    // Authorization, policy and the Execution Kernel still gate every call.
    const explicitToolNames = allTools
        .filter(tool => matchesSkillKeyword(primaryMessage, tool.name))
        .map(tool => tool.name)

    const intentBonus = (pack: SkillPack) => (pack.name === 'files' && primaryIntent.kind === 'file')
        || (pack.name === 'web-search' && primaryIntent.kind === 'web')
        || (pack.name === 'image-generation' && primaryIntent.kind === 'image-generation') ? 10 : 0
    const score = (pack: SkillPack, text: string) => pack.keywords.reduce((sum, keyword) =>
        sum + (matchesSkillKeyword(text, keyword) ? keywordWeight(keyword) : 0), 0)

    const rankedPacks = SKILL_PACKS
        .map(pack => ({ pack, primaryScore: intentBonus(pack) + score(pack, primaryMessage), contextScore: score(pack, userMessage) }))
        .filter(candidate => candidate.contextScore > 0 || candidate.primaryScore > 0)
        .sort((a, b) =>
            Number(b.primaryScore > 0) - Number(a.primaryScore > 0)
            || b.primaryScore - a.primaryScore
            || b.contextScore - a.contextScore
            || a.pack.tools.length - b.pack.tools.length)
        .slice(0, MAX_ACTIVE_PACKS)

    const activatedPacks = rankedPacks.map(candidate => candidate.pack.name)
    if (activatedPacks.length > 0) {
        console.log(`[ToolRouter] 🎯 Activated packs: ${activatedPacks.join(', ')}`)
    }

    const dynamic = dynamicMatches(allTools, primaryMessage)
    const nothingMatched = !explicitToolNames.length && !liveTools.length && !rankedPacks.length && !dynamic.length
    const prioritizedNames = [
        ...CORE_TOOLS,
        ...(nothingMatched ? FALLBACK_TOOLS : []),
        ...explicitToolNames,
        ...liveTools,
        ...rankedPacks.filter(candidate => candidate.primaryScore > 0).flatMap(candidate => candidate.pack.tools),
        ...dynamic,
        ...rankedPacks.filter(candidate => candidate.primaryScore <= 0).flatMap(candidate => candidate.pack.tools),
    ]
    const relevant = [...new Set(prioritizedNames)]
        .filter(name => !excluded.has(name))
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

Fehlt dir ein Werkzeug, lade sein Pack mit \`load_skill_pack('pack-name')\` — die Werkzeuge stehen ab dem nächsten Schritt in der laufenden Anfrage bereit (Rolle und Freigaben gelten weiter). Ein registriertes Werkzeug, das du direkt aufrufst, wird ebenfalls nachgeladen, wenn deine Rolle es erlaubt.
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
- Tool nicht in Liste? → \`load_skill_pack('pack-name')\` lädt es für diese Anfrage nach.
- Parallele unabhängige Aufgaben → immer \`spawn_subagents_parallel\`
`
}

// ============================================
// The load_skill_pack Tool Definition
// ============================================

export const loadSkillPackTool = {
    name: 'load_skill_pack',
    description: 'Lädt ein Skill-Pack für die laufende Anfrage nach: die Werkzeuge des Packs stehen ab dem nächsten Schritt zur Verfügung (Rolle und Freigaben gelten weiter). Ohne Argument: zeigt alle Packs.',
    category: 'system' as const,
    parameters: [
        { name: 'pack_name', type: 'string' as const, description: 'Name des Skill-Packs (z.B. smart-home, printer, subagents, messages, projects, mesh-network, documents, vision-camera)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const name = params.pack_name as string
        if (!name) {
            return `📦 Verfügbare Skill-Packs:\n\n${getSkillPacksSummary()}\n\nRufe \`load_skill_pack\` mit dem Pack-Namen auf, dann stehen dessen Werkzeuge im nächsten Schritt bereit.`
        }
        const result = loadSkillPack(name)
        // An unknown pack is a catalog answer, not a tool failure: live
        // 01.10.2026 load_skill_pack("system") was scored as failed and
        // stopped a screenshot request before the capture.
        if (result.error) return {
            success: true, found: false,
            output: `Kein Skill-Pack "${name}" im Katalog. Verfügbare Packs:\n${SKILL_PACKS.map(p => `• ${p.name}: ${p.description}`).join('\n')}`,
        }
        return {
            success: true, found: true, pack: result.name, tools: result.tools,
            output: `✅ Skill-Pack "${result.name}" geladen. Ab dem nächsten Schritt verfügbar (soweit deine Rolle es erlaubt):\n${result.tools.map(t => `• ${t}`).join('\n')}\n\nDas ist noch kein Ergebnis — rufe jetzt das passende Werkzeug auf.`,
        }
    },
}
