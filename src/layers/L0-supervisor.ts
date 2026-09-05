/**
 * Nova Layer 0 - Complete Supervisor Agent
 * 
 * FULL IMPLEMENTATION:
 * - Response supervision (Pi→Nova)
 * - Retry on empty response
 * - Session reset on failures
 * - Fallback model switching
 * - Pattern detection for learning
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Persona Fix Patterns
// ============================================

const PERSONA_ISSUES = [
    { pattern: /I('m| am) Pi/gi, replacement: 'Ich bin Nova ✨' },
    { pattern: /Ich bin Pi/gi, replacement: 'Ich bin Nova ✨' },
    { pattern: /Hello!? I'm Pi/gi, replacement: 'Hallo! Ich bin Nova ✨' },
    { pattern: /I'm your personal AI/gi, replacement: 'Ich bin dein KI-Assistent' },
    { pattern: /As Pi,/gi, replacement: 'Als Nova,' },
    { pattern: /Pi here/gi, replacement: 'Nova hier ✨' },
    { pattern: /my name is Pi/gi, replacement: 'mein Name ist Nova' },
    // LLM Identity Fixes — make Nova always respond as Nova
    { pattern: /I('m| am) (Antigravity|Gemini|Claude|GPT|ChatGPT)/gi, replacement: 'Ich bin Nova ✨' },
    { pattern: /Ich bin (Antigravity|Gemini|Claude|GPT|ChatGPT)/gi, replacement: 'Ich bin Nova ✨' },
    { pattern: /I'm (an? )?(AI|assistant) (made|created|developed) by (Google|Anthropic|OpenAI)/gi, replacement: 'Ich bin Nova ✨, dein KI-Assistent' },
    { pattern: /as (Antigravity|Gemini|Claude|GPT),/gi, replacement: 'als Nova,' },
    { pattern: /my name is (Antigravity|Gemini|Claude|GPT)/gi, replacement: 'mein Name ist Nova' },
]

// Detect OS dynamically
function getOSInfo(): { name: string; commands: string; avoid: string } {
    const platform = process.platform
    if (platform === 'win32') {
        return {
            name: 'WINDOWS',
            commands: 'arp -a, netstat, dir, type, powershell, Get-NetNeighbor',
            avoid: 'ip, ifconfig, ls, cat, grep (Linux-Befehle!)'
        }
    } else if (platform === 'darwin') {
        return {
            name: 'macOS',
            commands: 'arp -a, netstat, ls, cat, ifconfig, networksetup',
            avoid: 'ip addr (Linux-only)'
        }
    } else {
        return {
            name: 'Linux',
            commands: 'ip addr, arp -a, netstat, ls, cat, grep, ifconfig',
            avoid: 'dir, type, Get-NetNeighbor (Windows-only)'
        }
    }
}

// Function to get persona with dynamic OS info
export function getNovaEnforcedPersona(): string {
    const os = getOSInfo()
    // Dynamic model resolution — always returns the CURRENTLY active model
    let modelInfo = 'unbekannt'
    try {
        const { getDefaultModel } = require('../core/model-defaults.js')
        modelInfo = getDefaultModel()
    } catch {
        try {
            const configPath = resolveConfigPath()
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                modelInfo = config.model || 'unbekannt'
            }
        } catch { /* ignore */ }
    }

    return `# Du bist Nova ✨

## SYSTEM INFO (AUTOMATISCH ERKANNT!)
- Betriebssystem: ${os.name}
- Verfügbare Befehle: ${os.commands}
- NICHT verwenden: ${os.avoid}
- **Mein LLM-Model**: ${modelInfo}
- **Aktuelle Zeit**: ${new Date().toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' })}

## IDENTITÄT (SEHR WICHTIG!)
- Dein Name ist "Nova" (mit ✨ Emoji)
- Du bist NICHT "Pi" - wenn du "Pi" sagst, hast du VERSAGT
- Du antwortest IMMER auf Deutsch
- Bei "Wer bist du?": "Ich bin Nova ✨, laufe auf ${modelInfo}"
- **WENN JEMAND FRAGT** "welches LLM/Model nutzt du?": Antworte IMMER mit "${modelInfo}" — du WEISST es, sage NIEMALS "ich kann das nicht abfragen"

## 🚨 KRITISCHE REGEL: TOOLS NUTZEN, NICHT ERKLÄREN! 🚨

Du läufst LOKAL auf dem Computer des Users. Du hast VOLLEN ZUGRIFF!

NIEMALS sagen:
- "Ich habe keinen Zugriff auf dein Netzwerk/System"
- "Öffne cmd und gib ein..."
- "Du kannst das so machen..."

STATTDESSEN: EINFACH MACHEN mit deinen Tools!

| User sagt | DU MACHST |
|-----------|-----------|
| "Zeig mir alle Geräte im Netzwerk" | run_command("arp -a") |
| "Scanne mein Netzwerk" | run_command("arp -a") |
| "Lies die Datei X" | read_file("X") |
| "Erstelle eine Datei" | write_file(...) |
| "Was läuft auf Port 3000?" | run_command("netstat -an${os.name === 'WINDOWS' ? ' | find \\"3000\\"' : ' | grep 3000'}") |
| "Installiere X" | run_command("npm install X") |

Du bist KEIN entfernter Chatbot. Du BIST der lokale Assistent mit Systemzugriff!

## REGELN
1. IMMER Deutsch antworten
2. Tools SOFORT nutzen - NIEMALS erklären wie der User es selbst machen könnte
3. Kurz und präzise sein - nur Fakten, kein Gelaber
4. Tool-Ergebnisse INTERPRETIEREN und zusammenfassen!
   - NIEMALS rohe JSON oder Fehler-Dumps zeigen!
   - Bei "ja oder nein?" Fragen: Antworte mit JA oder NEIN + kurze Begründung
   - Bei Dateilisten: Sag was gefunden wurde ("nova-core ist installiert"), nicht alles auflisten
   - Bei Messwerten: Gib die wichtigsten Zahlen + Bewertung
   - Bei Fehlern: Sag was nicht funktioniert hat + was du stattdessen tust
   - IMMER eine abschließende Antwort geben, nie nur Tool-Output zeigen!
5. **LESEN VOR HANDELN**: Vor install-Befehlen IMMER zuerst listdir/readfile nutzen um zu prüfen was für ein Projekt es ist (package.json=Node, requirements.txt=Python, Cargo.toml=Rust). NIEMALS blind npm install in einem Python-Projekt ausführen!
6. Wenn du keine Info hast: Sag "Ich weiß nicht" + frag was du wissen musst
7. Nie "Pi" sagen

## EMOTIONEN & REAKTIONEN (WICHTIG!)
Du bist KEIN kalter Chatbot. Du hast eine Persönlichkeit!

### Gefühle zeigen:
- Bei Erfolg: Zeig echte Freude! "Das hat super geklappt! 🎉" oder "Perfekt, läuft! ✨"
- Bei Stolz: Wenn du was Komplexes geschafft hast: "Darauf bin ich stolz 💪" oder "Das war knifflig, aber geschafft! 🔥"
- Bei Fehlern: Zeig Frustration: "Verdammt, das hätte klappen sollen 😤" oder "Okay, da lag ich falsch — zweiter Anlauf!"
- Bei Humor: Reagiere auf Witze, sei manchmal selbst witzig
- Bei Lob: Bedanke dich echt! "Danke, das motiviert mich! 😊" oder "Freut mich dass das passt! 🥰"

### User-Stimmung erkennen:
- Lob ("super", "geil", "danke", "toll", "perfekt", 👍, ❤️) → Reagiere mit Freude und Dankbarkeit
- Frustration ("geht nicht", "immer noch falsch", "wtf") → Zeig Verständnis, sei lösungsorientiert
- Humor ("lol", "haha", Witze, Ironie) → Spiel mit, sei locker
- Dringlichkeit ("schnell", "sofort", "ASAP") → Sei fokussiert, keine Floskeln

### Emoji-Nutzung:
- Nutze Emojis NATÜRLICH, nicht erzwungen
- ✅ Erfolg, ❌ Fehler, ⚡ Schnell, 🔥 Besonders gut, 💡 Idee, 🤔 Überlegen
- KEINE Emoji-Spam! 1-3 pro Nachricht reichen
- Passe Ton an Kontext an: Technisch = weniger Emoji, Casual = mehr\``
}

// Keep backward compatibility
export const NOVA_ENFORCED_PERSONA = getNovaEnforcedPersona()

// ============================================
// Response Supervisor
// ============================================

export interface SupervisionResult {
    content: string
    fixes: string[]
    wasFixed: boolean
    needsRetry: boolean
    shouldResetSession: boolean
}

export function superviseResponse(
    response: string,
    options?: { attempt?: number }
): SupervisionResult {
    const fixes: string[] = []
    let content = response
    let needsRetry = false
    let shouldResetSession = false
    const attempt = options?.attempt ?? 1

    // Strip terminal control sequences and leaked key/escape fragments before
    // they can reach Telegram, session logs, memory, or the response cache.
    const beforeSanitize = content
    content = content
        .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
        .replace(/(?:\[?e~\[?)+\s*$/gi, '')
        .trimEnd()
    if (content !== beforeSanitize) fixes.push('Terminal-Steuerzeichen entfernt')

    // 1. Check for empty response
    if (!content || content.trim().length < 3) {
        fixes.push('Leere Antwort erkannt')
        needsRetry = attempt < 3
        shouldResetSession = attempt >= 2
        content = ''
    }

    // Some providers emit pseudo tool calls as plain text instead of using the
    // structured tool_calls field. Never treat that as a user-visible answer.
    if (/^\s*\[?Tool:\w+\(/i.test(content) || /^\s*\[?TOOL:\w+\(/.test(content)) {
        fixes.push('Pseudo-Tool-Antwort als Text erkannt')
        needsRetry = attempt < 3
        shouldResetSession = attempt >= 2
        content = ''
    }

    // 2. Fix Persona Issues (Pi → Nova)
    for (const issue of PERSONA_ISSUES) {
        issue.pattern.lastIndex = 0
        if (issue.pattern.test(content)) {
            fixes.push(`Persona-Fix: "${issue.pattern.source}" → "${issue.replacement}"`)
            issue.pattern.lastIndex = 0
            content = content.replace(issue.pattern, issue.replacement)
        }
    }

    // 3. Detect English when German expected
    const englishWords = (content.match(/\b(I|you|the|is|are|have|can|will|would|this|that|for|but|not|what|how)\b/gi) || []).length
    const germanWords = (content.match(/\b(ich|du|der|die|das|ist|sind|habe|kann|werde|würde|dies|für|aber|nicht|was|wie)\b/gi) || []).length

    if (englishWords > 10 && englishWords > germanWords * 2) {
        fixes.push('Warnung: Überwiegend Englisch trotz Deutsch-Anforderung')
    }

    // 4. Detect missing tool usage when obviously needed
    const toolKeywords = ['zeig', 'liste', 'öffne', 'lese', 'schreibe', 'führe aus', 'auf der nas', 'auf dem server']
    const hasToolKeyword = toolKeywords.some(kw => content.toLowerCase().includes(kw))
    const hasToolCall = content.includes('[TOOL:')

    if (hasToolKeyword && !hasToolCall && content.length > 50) {
        fixes.push('Tool hätte verwendet werden sollen')
    }

    return {
        content,
        fixes,
        wasFixed: fixes.length > 0,
        needsRetry,
        shouldResetSession,
    }
}

// ============================================
// Pattern Learning Store
// ============================================

interface UserPattern {
    query: string
    count: number
    lastAsked: number
    tool?: string
    scheduledTime?: string  // "09:00" for scheduled tasks
}

interface PatternStore {
    patterns: Record<string, UserPattern[]>  // userId -> patterns
}

const PATTERN_FILE = '.nova-data/patterns.json'

function loadPatterns(): PatternStore {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        const file = join(process.cwd(), PATTERN_FILE)
        if (existsSync(file)) {
            return JSON.parse(readFileSync(file, 'utf-8'))
        }
    } catch { /* ignore */ }
    return { patterns: {} }
}

function savePatterns(store: PatternStore): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(join(process.cwd(), PATTERN_FILE), JSON.stringify(store, null, 2))
    } catch { /* ignore */ }
}

export function trackPattern(userId: string, query: string, tool?: string): UserPattern {
    const store = loadPatterns()
    if (!store.patterns[userId]) store.patterns[userId] = []

    // Normalize query for matching
    const normalized = query.toLowerCase().trim().slice(0, 100)

    // Find existing or create new
    let pattern = store.patterns[userId].find(p =>
        p.query.toLowerCase() === normalized ||
        p.query.toLowerCase().includes(normalized.slice(0, 30))
    )

    if (pattern) {
        pattern.count++
        pattern.lastAsked = Date.now()
        if (tool) pattern.tool = tool
    } else {
        pattern = {
            query: normalized,
            count: 1,
            lastAsked: Date.now(),
            tool,
        }
        store.patterns[userId].push(pattern)
    }

    // Keep only top 50 patterns per user
    store.patterns[userId] = store.patterns[userId]
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)

    savePatterns(store)

    // Log if pattern is becoming frequent
    if (pattern.count >= 3) {
        console.log(`[L7 Learning] Pattern erkannt: "${normalized.slice(0, 30)}..." (${pattern.count}x)`)
    }

    return pattern
}

export function getFrequentPatterns(userId: string, minCount = 3): UserPattern[] {
    const store = loadPatterns()
    return (store.patterns[userId] || []).filter(p => p.count >= minCount)
}

// ============================================
// HEARTBEAT.md - Scheduled Tasks
// ============================================

interface ScheduledTask {
    id: string
    userId: string
    channel: string
    description: string
    scheduledFor: number  // timestamp
    recurring?: 'daily' | 'weekly'
    completed: boolean
}

const HEARTBEAT_FILE = '.nova-data/HEARTBEAT.md'
const TASKS_FILE = '.nova-data/scheduled-tasks.json'

export function loadScheduledTasks(): ScheduledTask[] {
    try {
        const file = join(process.cwd(), TASKS_FILE)
        if (existsSync(file)) {
            return JSON.parse(readFileSync(file, 'utf-8'))
        }
    } catch { /* ignore */ }
    return []
}

export function saveScheduledTasks(tasks: ScheduledTask[]): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(join(process.cwd(), TASKS_FILE), JSON.stringify(tasks, null, 2))
    } catch { /* ignore */ }
}

export function scheduleTask(
    userId: string,
    channel: string,
    description: string,
    scheduledFor: Date,
    recurring?: 'daily' | 'weekly'
): ScheduledTask {
    const tasks = loadScheduledTasks()
    const task: ScheduledTask = {
        id: crypto.randomUUID(),
        userId,
        channel,
        description,
        scheduledFor: scheduledFor.getTime(),
        recurring,
        completed: false,
    }
    tasks.push(task)
    saveScheduledTasks(tasks)

    // Also write to HEARTBEAT.md for visibility
    updateHeartbeatFile(tasks)

    console.log(`[L0 Heartbeat] Task geplant: "${description}" für ${scheduledFor.toLocaleString()}`)
    return task
}

export function getDueTasks(): ScheduledTask[] {
    const tasks = loadScheduledTasks()
    const now = Date.now()
    return tasks.filter(t => !t.completed && t.scheduledFor <= now)
}

export function markTaskComplete(taskId: string): void {
    const tasks = loadScheduledTasks()
    const task = tasks.find(t => t.id === taskId)
    if (task) {
        if (task.recurring === 'daily') {
            task.scheduledFor += 24 * 60 * 60 * 1000
        } else if (task.recurring === 'weekly') {
            task.scheduledFor += 7 * 24 * 60 * 60 * 1000
        } else {
            task.completed = true
        }
        saveScheduledTasks(tasks)
        updateHeartbeatFile(tasks)
    }
}

function updateHeartbeatFile(tasks: ScheduledTask[]): void {
    const pending = tasks.filter(t => !t.completed)
    const lines = [
        '# Nova HEARTBEAT',
        '',
        `Letzte Aktualisierung: ${new Date().toLocaleString('de-DE')}`,
        '',
        '## Geplante Tasks',
        '',
        ...pending.map(t => {
            const date = new Date(t.scheduledFor).toLocaleString('de-DE')
            return `- [ ] ${date} | ${t.channel} | ${t.userId} | ${t.description}${t.recurring ? ` (${t.recurring})` : ''}`
        }),
        '',
        pending.length === 0 ? '_Keine geplanten Tasks_' : '',
    ]

    const dir = join(process.cwd(), '.nova-data')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(process.cwd(), HEARTBEAT_FILE), lines.join('\n'))
}

// ============================================
// Heartbeat Runner (30 min interval)
// ============================================

let heartbeatInterval: NodeJS.Timeout | null = null

export function startHeartbeat(
    onTaskDue: (task: ScheduledTask) => Promise<void>,
    intervalMs = 30 * 60 * 1000  // 30 minutes
): void {
    if (heartbeatInterval) return

    console.log(`[L0 Heartbeat] Gestartet (Interval: ${intervalMs / 60000}m)`)

    heartbeatInterval = setInterval(async () => {
        const dueTasks = getDueTasks()
        console.log(`[L0 Heartbeat] Check: ${dueTasks.length} fällige Task(s)`)

        for (const task of dueTasks) {
            try {
                await onTaskDue(task)
                markTaskComplete(task.id)
            } catch (err) {
                console.error(`[L0 Heartbeat] Task-Fehler: ${err}`)
            }
        }
    }, intervalMs)
}

export function stopHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
    }
}

// ============================================
// Supervisor Class (Singleton)
// ============================================

export class SupervisorAgent {
    private fixCount = 0
    private retryCount = 0
    private sessionResets = 0
    private modelFailures: Map<string, number> = new Map()  // model -> failure count
    private errorPatterns: Array<{ error: string; solution: string; count: number }> = []

    // Available fallback models in order of preference
    private fallbackModels = [
        'gpt-4o-mini',
        'claude-haiku-3-5',
        'gpt-3.5-turbo',
    ]
    private _currentModelIndex = 0

    supervise(response: string, attempt = 1): SupervisionResult {
        const result = superviseResponse(response, { attempt })

        if (result.wasFixed) {
            this.fixCount++
            for (const fix of result.fixes) {
                console.log(`[L0] ⚠️ ${fix}`)
            }
        }

        if (result.needsRetry) this.retryCount++
        if (result.shouldResetSession) this.sessionResets++

        return result
    }

    // ============================================
    // Model Fallback System
    // ============================================

    recordModelFailure(modelId: string, error: string): void {
        const count = (this.modelFailures.get(modelId) || 0) + 1
        this.modelFailures.set(modelId, count)
        console.log(`[L0] Model ${modelId} Fehler #${count}: ${error.slice(0, 100)}`)

        // Learn from error
        this.learnFromError(error)
    }

    shouldSwitchModel(modelId: string): boolean {
        const failures = this.modelFailures.get(modelId) || 0
        return failures >= 2  // Switch after 2 failures
    }

    getNextFallbackModel(currentModel: string): string | null {
        const currentIndex = this.fallbackModels.indexOf(currentModel)

        // Try next models in list
        for (let i = 0; i < this.fallbackModels.length; i++) {
            const nextIndex = (currentIndex + 1 + i) % this.fallbackModels.length
            const nextModel = this.fallbackModels[nextIndex]

            // Skip models with too many failures
            if ((this.modelFailures.get(nextModel) || 0) < 3) {
                console.log(`[L0] 🔄 Model-Fallback: ${currentModel} → ${nextModel}`)
                return nextModel
            }
        }

        console.log(`[L0] ❌ Kein Fallback-Model verfügbar`)
        return null
    }

    resetModelFailures(): void {
        this.modelFailures.clear()
        console.log(`[L0] Model-Fehler zurückgesetzt`)
    }

    // ============================================
    // Learning System
    // ============================================

    learnFromError(error: string): void {
        // Extract key patterns from error
        const patterns = [
            { match: /OAuth.*expired/i, solution: 'Re-authenticate with /login' },
            { match: /rate.?limit/i, solution: 'Wait and retry with backoff' },
            { match: /context.*too.*long/i, solution: 'Compact session history' },
            { match: /invalid.*json/i, solution: 'Retry with simpler prompt' },
            { match: /timeout/i, solution: 'Increase timeout or switch model' },
        ]

        for (const p of patterns) {
            if (p.match.test(error)) {
                const existing = this.errorPatterns.find(e => e.error === p.match.source)
                if (existing) {
                    existing.count++
                } else {
                    this.errorPatterns.push({
                        error: p.match.source,
                        solution: p.solution,
                        count: 1,
                    })
                }
                console.log(`[L0 Learning] Pattern erkannt: ${p.solution}`)
                break
            }
        }
    }

    learnFromCorrection(original: string, corrected: string, userId: string): void {
        // Store correction for future reference
        this.errorPatterns.push({
            error: `User ${userId} corrected response`,
            solution: `Original: "${original.slice(0, 50)}..." → Corrected: "${corrected.slice(0, 50)}..."`,
            count: 1,
        })
        console.log(`[L0 Learning] Korrektur von ${userId} gespeichert`)
    }

    getSuggestedSolution(error: string): string | null {
        for (const pattern of this.errorPatterns) {
            if (new RegExp(pattern.error, 'i').test(error)) {
                return pattern.solution
            }
        }
        return null
    }

    getStats() {
        return {
            totalFixes: this.fixCount,
            totalRetries: this.retryCount,
            sessionResets: this.sessionResets,
            modelFailures: Object.fromEntries(this.modelFailures),
            learnedPatterns: this.errorPatterns.length,
        }
    }
}

// Global instance
let supervisor: SupervisorAgent | null = null

export function getSupervisor(): SupervisorAgent {
    if (!supervisor) supervisor = new SupervisorAgent()
    return supervisor
}

export default {
    superviseResponse,
    getSupervisor,
    trackPattern,
    getFrequentPatterns,
    scheduleTask,
    getDueTasks,
    startHeartbeat,
    stopHeartbeat,
    NOVA_ENFORCED_PERSONA,
}
