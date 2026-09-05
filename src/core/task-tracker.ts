/**
 * Nova Task Tracker
 * 
 * Tracks what Nova is currently doing, breaks complex requests
 * into steps, and persists progress to disk.
 * 
 * Used by:
 * - /task command (Telegram)
 * - Dashboard (WebSocket + REST)
 * - Pipeline (auto-tracking)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface TaskStep {
    id: number
    description: string
    status: 'pending' | 'active' | 'done' | 'failed'
    tool?: string
    startedAt?: number
    finishedAt?: number
    error?: string
}

export interface TrackedTask {
    id: string
    userMessage: string
    summary: string
    steps: TaskStep[]
    currentStep: number
    status: 'planning' | 'active' | 'done' | 'failed'
    channel: string
    user: string
    startedAt: number
    finishedAt?: number
    duration?: number
}

interface TaskTrackerState {
    currentTask: TrackedTask | null
    history: TrackedTask[]
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const TRACKER_FILE = join(DATA_DIR, 'task-tracker.json')

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function loadState(): TaskTrackerState {
    try {
        if (existsSync(TRACKER_FILE)) {
            return JSON.parse(readFileSync(TRACKER_FILE, 'utf-8'))
        }
    } catch { /* fresh start */ }
    return { currentTask: null, history: [] }
}

function saveState(state: TaskTrackerState): void {
    ensureDir()
    // Keep only last 50 tasks in history
    state.history = state.history.slice(-50)
    writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2))
}

// ============================================
// Singleton State
// ============================================

let trackerState = loadState()
let internalLlm: any = null
let onUpdate: ((task: TrackedTask | null) => void) | null = null

// ============================================
// LLM Integration
// ============================================

export function setLLM(llm: any): void {
    internalLlm = llm
    console.log('[TaskTracker] ✓ Internal LLM connected — smart task decomposition enabled')
}

export function setUpdateCallback(cb: (task: TrackedTask | null) => void): void {
    onUpdate = cb
}

function notifyUpdate(): void {
    if (onUpdate && trackerState.currentTask) {
        onUpdate(trackerState.currentTask)
    }
}

/**
 * Use LLM to break a complex request into steps.
 * Falls back to simple 3-step plan if LLM unavailable.
 */
async function decomposeWithLLM(userMessage: string): Promise<TaskStep[]> {
    // Simple messages don't need decomposition
    const wordCount = userMessage.split(/\s+/).length
    if (wordCount < 5) {
        return [
            { id: 1, description: 'Anfrage verarbeiten', status: 'pending' },
            { id: 2, description: 'Antwort erstellen', status: 'pending' },
        ]
    }

    if (!internalLlm) {
        return createFallbackSteps(userMessage)
    }

    try {
        const prompt = `Zerlege diese Benutzeranfrage in 2-6 konkrete Arbeitsschritte. 
Antworte NUR mit einer JSON-Array von Strings, keine Erklärung.

Anfrage: "${userMessage.slice(0, 300)}"

Beispiel-Antwort: ["SSH Verbindung aufbauen", "Logfiles lesen", "Ergebnis zusammenfassen"]`

        const result = await Promise.race([
            internalLlm.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ])

        if (result) {
            const text = result?.response?.text?.() || result?.text?.() || ''
            const match = text.match(/\[[\s\S]*\]/)
            if (match) {
                const steps: string[] = JSON.parse(match[0])
                return steps.map((s, i) => ({
                    id: i + 1,
                    description: s,
                    status: 'pending' as const,
                }))
            }
        }
    } catch (err) {
        console.log(`[TaskTracker] LLM decomposition failed: ${err}`)
    }

    return createFallbackSteps(userMessage)
}

function createFallbackSteps(msg: string): TaskStep[] {
    const steps: TaskStep[] = [
        { id: 1, description: 'Anfrage analysieren', status: 'pending' },
    ]

    // Detect patterns for smarter fallback
    const lower = msg.toLowerCase()
    if (lower.includes('ssh') || lower.includes('server')) {
        steps.push({ id: 2, description: 'Verbindung herstellen', status: 'pending' })
    }
    if (lower.includes('datei') || lower.includes('file') || lower.includes('log')) {
        steps.push({ id: steps.length + 1, description: 'Dateien verarbeiten', status: 'pending' })
    }
    if (lower.includes('install') || lower.includes('update')) {
        steps.push({ id: steps.length + 1, description: 'Installation durchführen', status: 'pending' })
    }

    steps.push({ id: steps.length + 1, description: 'Ergebnis zusammenfassen', status: 'pending' })

    return steps
}

// ============================================
// Public API
// ============================================

/**
 * Start tracking a new task. Called from pipeline when processing begins.
 */
export async function startTask(userMessage: string, channel: string, user: string): Promise<TrackedTask> {
    // If there's an active task, finish it first
    if (trackerState.currentTask && trackerState.currentTask.status === 'active') {
        completeTask()
    }

    const steps = await decomposeWithLLM(userMessage)

    // Activate first step
    if (steps.length > 0) {
        steps[0].status = 'active'
        steps[0].startedAt = Date.now()
    }

    const task: TrackedTask = {
        id: crypto.randomUUID().slice(0, 8),
        userMessage,
        summary: userMessage.slice(0, 100),
        steps,
        currentStep: 0,
        status: 'active',
        channel,
        user,
        startedAt: Date.now(),
    }

    trackerState.currentTask = task
    saveState(trackerState)
    notifyUpdate()
    console.log(`[TaskTracker] Started: "${task.summary}" (${steps.length} steps)`)
    return task
}

/**
 * Advance to next step. Called when a tool finishes or major progress made.
 */
export function advanceStep(toolName?: string, success = true): void {
    const task = trackerState.currentTask
    if (!task || task.status !== 'active') return

    const current = task.steps[task.currentStep]
    if (current) {
        current.status = success ? 'done' : 'failed'
        current.finishedAt = Date.now()
        if (toolName) current.tool = toolName
        if (!success) current.error = 'Tool execution failed'
    }

    // Move to next step
    const nextIdx = task.currentStep + 1
    if (nextIdx < task.steps.length) {
        task.currentStep = nextIdx
        task.steps[nextIdx].status = 'active'
        task.steps[nextIdx].startedAt = Date.now()
    }

    saveState(trackerState)
    notifyUpdate()
}

/**
 * Complete the current task. Called after reply is sent.
 */
export function completeTask(failed = false): void {
    const task = trackerState.currentTask
    if (!task) return

    // Mark remaining steps
    for (const step of task.steps) {
        if (step.status === 'active') step.status = failed ? 'failed' : 'done'
        if (step.status === 'pending') step.status = failed ? 'failed' : 'done'
        if (!step.finishedAt && step.status === 'done') step.finishedAt = Date.now()
    }

    task.status = failed ? 'failed' : 'done'
    task.finishedAt = Date.now()
    task.duration = task.finishedAt - task.startedAt

    // Move to history
    trackerState.history.push(task)
    trackerState.currentTask = null
    saveState(trackerState)
    notifyUpdate()

    const dur = task.duration < 1000
        ? `${task.duration}ms`
        : `${(task.duration / 1000).toFixed(1)}s`
    console.log(`[TaskTracker] Completed: "${task.summary}" in ${dur}`)
}

/**
 * Get formatted status for /task command.
 */
export function getFormattedStatus(): string {
    const task = trackerState.currentTask

    if (!task) {
        // Show last completed task
        const last = trackerState.history[trackerState.history.length - 1]
        if (last) {
            const dur = last.duration
                ? last.duration < 1000
                    ? `${last.duration}ms`
                    : `${(last.duration / 1000).toFixed(1)}s`
                : '?'
            return `💤 *Keine aktive Aufgabe*

📋 Letzte Aufgabe:
"${last.summary}"
✅ Abgeschlossen in ${dur} (${last.steps.length} Schritte)
📅 ${new Date(last.finishedAt || last.startedAt).toLocaleString('de-DE')}`
        }
        return '💤 *Keine aktive Aufgabe* — Ich warte auf deine nächste Anfrage.'
    }

    const doneCount = task.steps.filter(s => s.status === 'done').length
    const total = task.steps.length
    const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1)

    // Progress bar
    const filled = Math.round((doneCount / total) * 8)
    const bar = '█'.repeat(filled) + '░'.repeat(8 - filled)

    // Step list
    const stepLines = task.steps.map(s => {
        const icon = s.status === 'done' ? '✅'
            : s.status === 'active' ? '🔄'
                : s.status === 'failed' ? '❌'
                    : '⬜'
        const toolInfo = s.tool ? ` (${s.tool})` : ''
        return `${icon} ${s.description}${toolInfo}`
    }).join('\n')

    return `📋 *Aktuelle Aufgabe:*
"${task.summary}"

*Fortschritt:* ${bar} Schritt ${doneCount + 1}/${total}
${stepLines}

⏱ Laufzeit: ${elapsed}s | 📡 ${task.channel}`
}

/**
 * Get task history formatted for /task history.
 */
export function getFormattedHistory(count = 5): string {
    const tasks = trackerState.history.slice(-count).reverse()

    if (tasks.length === 0) {
        return '📋 *Task-History*\n\nNoch keine abgeschlossenen Aufgaben.'
    }

    const lines = tasks.map((t, i) => {
        const dur = t.duration
            ? t.duration < 1000 ? `${t.duration}ms` : `${(t.duration / 1000).toFixed(1)}s`
            : '?'
        const icon = t.status === 'done' ? '✅' : '❌'
        const date = new Date(t.startedAt).toLocaleString('de-DE', {
            hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
        })
        return `${i + 1}. ${icon} ${t.summary}\n   ${t.steps.length} Schritte | ${dur} | ${date}`
    }).join('\n\n')

    return `📋 *Task-History* (letzte ${tasks.length})\n\n${lines}`
}

/**
 * Get current task data for dashboard API.
 */
export function getTaskData(): { current: TrackedTask | null, history: TrackedTask[] } {
    return {
        current: trackerState.currentTask,
        history: trackerState.history.slice(-20),
    }
}

// ============================================
// Real-time console.log Ring Buffer
// ============================================

const LOG_RING_SIZE = 200
const logRing: string[] = []
let logInterceptorInstalled = false

/**
 * Install console.log interceptor to capture logs in real-time.
 * Call this once at daemon startup.
 */
export function installLogInterceptor(): void {
    if (logInterceptorInstalled) return
    logInterceptorInstalled = true

    const originalLog = console.log.bind(console)
    const originalWarn = console.warn.bind(console)
    const originalError = console.error.bind(console)

    const capture = (level: string, args: unknown[]): void => {
        const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
        // Clean up ANSI codes and excessive whitespace
        const clean = msg.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim()
        if (!clean) return
        logRing.push(`[${time}] ${clean}`)
        if (logRing.length > LOG_RING_SIZE) logRing.shift()
    }

    console.log = (...args: unknown[]) => {
        capture('LOG', args)
        originalLog(...args)
    }
    console.warn = (...args: unknown[]) => {
        capture('⚠', args)
        originalWarn(...args)
    }
    console.error = (...args: unknown[]) => {
        capture('❌', args)
        originalError(...args)
    }
}

/**
 * Get recent log lines from the real-time ring buffer.
 * Falls back to nova.log if ring buffer is empty (interceptor not installed).
 */
export function getLogLines(count = 20): string[] {
    // Primary: Live ring buffer (real-time console.log capture)
    if (logRing.length > 0) {
        return logRing.slice(-Math.min(count, 50))
    }

    // Fallback: nova.log (if ring buffer empty / interceptor not installed)
    const logFile = join(process.cwd(), 'nova.log')
    try {
        if (!existsSync(logFile)) return ['Keine Logs verfügbar. Log-Interceptor nicht aktiv.']
        const content = readFileSync(logFile, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())
        return lines.slice(-Math.min(count, 50))
    } catch (err) {
        return [`Error reading log: ${err}`]
    }
}

/**
 * Get formatted log output for /log command.
 */
export function getFormattedLogs(count = 20): string {
    const lines = getLogLines(count)
    const formatted = lines.map(l => {
        // Trim long lines for Telegram
        return l.length > 120 ? l.slice(0, 117) + '...' : l
    }).join('\n')

    return `📜 *Letzte ${lines.length} Log-Einträge:*\n\n\`\`\`\n${formatted}\n\`\`\``
}

