/**
 * Nova Replan Engine — Autonomous Error Recovery
 *
 * When a task fails, instead of just stopping (stop-loss), this engine:
 * 1. Analyzes the failure root-cause
 * 2. Generates a revised plan via LLM
 * 3. Retries the task up to MAX_REPLANS times
 *
 * Inspired by Mark XXXIX's executor.py replanning loop.
 *
 * Usage:
 *   const result = await withReplanning(taskId, goal, executeTask)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface ReplanContext {
    taskId: string
    goal: string
    attempt: number
    previousPlan?: string
    error: string
    errorType: 'tool_failure' | 'timeout' | 'logic_error' | 'missing_resource' | 'permission' | 'unknown'
    toolCallHistory: Array<{ tool: string; result: string; success: boolean }>
}

export interface ReplanResult {
    revisedPlan: string
    reasoning: string
    newApproach: string
    estimatedSteps: number
    shouldAbandon: boolean
    abandonReason?: string
}

export interface ReplanAttempt {
    taskId: string
    goal: string
    attemptNumber: number
    error: string
    revisedPlan: string
    success: boolean
    timestamp: number
    durationMs: number
}

export interface ReplanStats {
    totalReplans: number
    successfulReplans: number
    abandonedTasks: number
    averageAttemptsPerSuccess: number
}

// ============================================
// Config
// ============================================

const MAX_REPLANS = 2
const DATA_DIR = join(process.cwd(), '.nova-data', 'replanning')
const LOG_FILE = join(DATA_DIR, 'replan-log.json')

// ============================================
// State
// ============================================

let replanLog: ReplanAttempt[] = []
let llmFn: ((prompt: string) => Promise<string>) | null = null

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function loadLog(): void {
    ensureDir()
    try {
        if (existsSync(LOG_FILE)) {
            replanLog = JSON.parse(readFileSync(LOG_FILE, 'utf-8'))
        }
    } catch { replanLog = [] }
}

function saveLog(): void {
    try {
        ensureDir()
        // Keep last 100 entries
        writeFileSync(LOG_FILE, JSON.stringify(replanLog.slice(-100), null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Error Classification
// ============================================

export function classifyError(error: string): ReplanContext['errorType'] {
    const e = error.toLowerCase()
    if (/timeout|timed out|took too long/i.test(e)) return 'timeout'
    if (/permission denied|access denied|unauthorized|forbidden/i.test(e)) return 'permission'
    if (/not found|no such file|enoent|missing|does not exist/i.test(e)) return 'missing_resource'
    if (/type error|cannot read|undefined|null|is not a function/i.test(e)) return 'logic_error'
    if (/tool failed|tool error|command failed|exit code/i.test(e)) return 'tool_failure'
    return 'unknown'
}

// ============================================
// LLM Integration
// ============================================

export function setReplanLlm(fn: (prompt: string) => Promise<string>): void {
    llmFn = fn
}

async function callLlm(prompt: string): Promise<string> {
    if (llmFn) {
        try {
            return await llmFn(prompt)
        } catch { /* fall through to mock */ }
    }

    // Offline fallback: simple heuristic plan
    return JSON.stringify({
        revisedPlan: 'Versuche den Task mit einem einfacheren Ansatz: Teile das Ziel in kleinere Schritte auf und überprüfe jeden einzelnen.',
        reasoning: 'LLM nicht verfügbar — generischer Fallback-Plan.',
        newApproach: 'Schrittweise Ausführung mit Validierung nach jedem Schritt.',
        estimatedSteps: 3,
        shouldAbandon: false,
    })
}

// ============================================
// Core: Generate Revised Plan
// ============================================

export async function generateRevisedPlan(ctx: ReplanContext): Promise<ReplanResult> {
    const toolHistory = ctx.toolCallHistory
        .slice(-5)  // last 5 tool calls for context
        .map(t => `  - ${t.tool}: ${t.success ? '✅' : '❌'} ${t.result.slice(0, 100)}`)
        .join('\n')

    const prompt = `Du bist ein KI-Assistent der einen fehlgeschlagenen Task analysiert und einen neuen Plan erstellt.

**Fehlgeschlagener Task:** ${ctx.goal}
**Versuch:** ${ctx.attempt} von ${MAX_REPLANS}
**Fehler:** ${ctx.error}
**Fehler-Typ:** ${ctx.errorType}

**Bisherige Tool-Aufrufe:**
${toolHistory || '  (keine bisherigen Tool-Aufrufe)'}

${ctx.previousPlan ? `**Vorheriger Plan:**\n${ctx.previousPlan}\n` : ''}

**Aufgabe:** Analysiere warum der Task fehlgeschlagen ist und erstelle einen ANDEREN Ansatz.
- Wenn Versuch ${ctx.attempt} >= ${MAX_REPLANS}: Empfehle shouldAbandon=true wenn der Task nicht lösbar erscheint.
- Schlage einen konkreten, anderen Ansatz vor der die gleichen Tools anders nutzt.

Antworte NUR mit validem JSON:
{
  "revisedPlan": "Schritt-für-Schritt Plan (konkret, anders als vorher)",
  "reasoning": "Warum der vorherige Versuch scheiterte",
  "newApproach": "Kernunterschied zum vorherigen Versuch (1 Satz)",
  "estimatedSteps": 3,
  "shouldAbandon": false,
  "abandonReason": null
}`

    try {
        const response = await callLlm(prompt)

        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            return {
                revisedPlan: parsed.revisedPlan || 'Kein Plan generiert',
                reasoning: parsed.reasoning || '',
                newApproach: parsed.newApproach || '',
                estimatedSteps: parsed.estimatedSteps || 3,
                shouldAbandon: parsed.shouldAbandon || false,
                abandonReason: parsed.abandonReason || undefined,
            }
        }
    } catch (err) {
        console.error(`[ReplanEngine] Plan-Generierung fehlgeschlagen: ${err}`)
    }

    return {
        revisedPlan: `Alternativer Ansatz: ${ctx.goal} — versuche es mit einem einfacheren Teilschritt.`,
        reasoning: 'Plan-Generierung fehlgeschlagen, generischer Fallback.',
        newApproach: 'Vereinfachter Ansatz',
        estimatedSteps: 2,
        shouldAbandon: ctx.attempt >= MAX_REPLANS,
    }
}

// ============================================
// Main: withReplanning Wrapper
// ============================================

/**
 * Wraps a task execution function with automatic replanning on failure.
 *
 * @param taskId   Unique ID for tracking
 * @param goal     Human-readable goal description
 * @param execute  Async function that executes the task, receives the current plan
 * @param initialPlan  Optional initial plan to start with
 *
 * @returns { success, result, attempts, finalPlan }
 */
export async function withReplanning<T>(
    taskId: string,
    goal: string,
    execute: (plan: string, attempt: number) => Promise<T>,
    initialPlan?: string,
): Promise<{
    success: boolean
    result?: T
    error?: string
    attempts: number
    finalPlan: string
    abandoned: boolean
}> {
    loadLog()

    let currentPlan = initialPlan || goal
    let toolHistory: ReplanContext['toolCallHistory'] = []

    for (let attempt = 1; attempt <= MAX_REPLANS + 1; attempt++) {
        const startTime = Date.now()
        console.log(`[ReplanEngine] Task "${taskId}" — Versuch ${attempt}/${MAX_REPLANS + 1}`)

        try {
            const result = await execute(currentPlan, attempt)

            // Success
            const logEntry: ReplanAttempt = {
                taskId, goal, attemptNumber: attempt,
                error: '',
                revisedPlan: currentPlan,
                success: true,
                timestamp: Date.now(),
                durationMs: Date.now() - startTime,
            }
            replanLog.push(logEntry)
            saveLog()

            if (attempt > 1) {
                console.log(`[ReplanEngine] ✅ Task "${taskId}" erfolgreich nach ${attempt} Versuchen`)
            }

            return { success: true, result, attempts: attempt, finalPlan: currentPlan, abandoned: false }

        } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            const errorType = classifyError(error)

            console.log(`[ReplanEngine] ❌ Versuch ${attempt} fehlgeschlagen: ${error.slice(0, 100)}`)

            // Log the failed attempt
            replanLog.push({
                taskId, goal, attemptNumber: attempt,
                error,
                revisedPlan: currentPlan,
                success: false,
                timestamp: Date.now(),
                durationMs: Date.now() - startTime,
            })
            saveLog()

            // No more replans allowed
            if (attempt > MAX_REPLANS) {
                console.log(`[ReplanEngine] 🛑 Max Replans (${MAX_REPLANS}) erreicht — gebe auf`)
                return { success: false, error, attempts: attempt, finalPlan: currentPlan, abandoned: true }
            }

            // Generate revised plan
            console.log(`[ReplanEngine] 🔄 Generiere neuen Plan (Versuch ${attempt + 1})...`)
            const ctx: ReplanContext = {
                taskId, goal, attempt,
                previousPlan: currentPlan,
                error, errorType,
                toolCallHistory: toolHistory,
            }

            const replan = await generateRevisedPlan(ctx)

            if (replan.shouldAbandon) {
                console.log(`[ReplanEngine] 🛑 LLM empfiehlt Abbruch: ${replan.abandonReason}`)
                return { success: false, error: replan.abandonReason || error, attempts: attempt, finalPlan: currentPlan, abandoned: true }
            }

            console.log(`[ReplanEngine] 📋 Neuer Ansatz: ${replan.newApproach}`)
            currentPlan = replan.revisedPlan
        }
    }

    // Should never reach here
    return { success: false, error: 'Unerwarteter Zustand', attempts: MAX_REPLANS + 1, finalPlan: currentPlan, abandoned: true }
}

// ============================================
// Tool History Tracking
// ============================================

const activeToolHistories = new Map<string, ReplanContext['toolCallHistory']>()

export function trackToolCall(taskId: string, tool: string, result: string, success: boolean): void {
    if (!activeToolHistories.has(taskId)) {
        activeToolHistories.set(taskId, [])
    }
    const history = activeToolHistories.get(taskId)!
    history.push({ tool, result: result.slice(0, 200), success })
    // Keep last 20
    if (history.length > 20) history.shift()
}

export function clearToolHistory(taskId: string): void {
    activeToolHistories.delete(taskId)
}

// ============================================
// Stats & Reporting
// ============================================

export function getReplanStats(): ReplanStats {
    loadLog()
    const total = replanLog.filter(e => e.attemptNumber > 1).length
    const successful = replanLog.filter(e => e.attemptNumber > 1 && e.success).length

    const taskAttempts = new Map<string, number>()
    for (const e of replanLog.filter(e => e.success)) {
        taskAttempts.set(e.taskId, e.attemptNumber)
    }
    const avgAttempts = taskAttempts.size > 0
        ? Array.from(taskAttempts.values()).reduce((a, b) => a + b, 0) / taskAttempts.size
        : 0

    return {
        totalReplans: total,
        successfulReplans: successful,
        abandonedTasks: replanLog.filter(e => e.attemptNumber > MAX_REPLANS && !e.success).length,
        averageAttemptsPerSuccess: Math.round(avgAttempts * 10) / 10,
    }
}

export function getReplanHistory(limit = 20): ReplanAttempt[] {
    loadLog()
    return replanLog.slice(-limit)
}

export function formatReplanStatus(): string {
    const stats = getReplanStats()
    const recent = getReplanHistory(5)
    const successRate = stats.totalReplans > 0
        ? Math.round((stats.successfulReplans / stats.totalReplans) * 100)
        : 0

    let out = `🔄 *Replan Engine Status*\n`
    out += `Replans gesamt: ${stats.totalReplans}\n`
    out += `Erfolgreich: ${stats.successfulReplans} (${successRate}%)\n`
    out += `Abgebrochen: ${stats.abandonedTasks}\n`
    out += `Ø Versuche bis Erfolg: ${stats.averageAttemptsPerSuccess}\n`

    if (recent.length > 0) {
        out += `\n*Letzte Replans:*\n`
        for (const r of recent.slice(-3)) {
            const icon = r.success ? '✅' : '❌'
            out += `${icon} [${r.taskId}] Versuch ${r.attemptNumber}: ${r.error.slice(0, 60)}\n`
        }
    }
    return out
}

export default {
    withReplanning,
    generateRevisedPlan,
    classifyError,
    trackToolCall,
    clearToolHistory,
    setReplanLlm,
    getReplanStats,
    getReplanHistory,
    formatReplanStatus,
}
