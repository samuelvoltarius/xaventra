/**
 * Model Performance Database
 *
 * Tracks per-model performance metrics across task types:
 * - Average latency (ms)
 * - Success rate
 * - Per-task-type affinity (which models actually work for what)
 *
 * Persisted to .nova-data/model-perf.json (survives restarts).
 * Fed into L18 Router to bias model selection based on real-world results.
 *
 * Design goals:
 * - Zero overhead on the hot path (in-memory, async writes)
 * - Self-correcting: a model that keeps failing gets a permanent score penalty
 * - Self-discovering: a model that excels at a task type gets promoted for it
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

// ============================================
// Types
// ============================================

export interface ModelPerfEntry {
    model: string
    totalCalls: number
    totalSuccesses: number
    totalLatencyMs: number
    // Per task-type breakdown
    taskStats: Record<string, {
        calls: number
        successes: number
        totalLatencyMs: number
    }>
    // Consecutive failures tracker (reset on success)
    consecutiveFails: number
    lastUpdated: string
    // Auto-disable: set to ISO timestamp when model should be re-enabled (null = not disabled)
    disabledUntil?: string | null
}

interface PerfDB {
    entries: Record<string, ModelPerfEntry>
    schemaVersion: number
    lastSaved: string
}

// ============================================
// Storage
// ============================================

const PERF_FILE = '.nova-data/model-perf.json'
const SAVE_DEBOUNCE_MS = 5000  // write at most once every 5s

let _db: PerfDB | null = null
let _dirty = false
let _saveTimer: ReturnType<typeof setTimeout> | null = null
const recordingScope = new AsyncLocalStorage<boolean>()

export function isModelPerformanceRecordingEnabled(): boolean {
    return recordingScope.getStore() !== false
}

export function withModelPerformanceRecording<T>(
    enabled: boolean,
    operation: () => T | Promise<T>,
): T | Promise<T> {
    return recordingScope.run(enabled, operation)
}

function getDbPath(): string {
    return join(process.cwd(), PERF_FILE)
}

function loadDB(): PerfDB {
    if (_db) return _db
    try {
        const path = getDbPath()
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PerfDB
            if (parsed.schemaVersion === 1) {
                _db = parsed
                return _db
            }
        }
    } catch { /* corrupt or missing — start fresh */ }

    _db = { entries: {}, schemaVersion: 1, lastSaved: new Date().toISOString() }
    return _db
}

function scheduleSave(): void {
    _dirty = true
    if (_saveTimer) return
    _saveTimer = setTimeout(() => {
        _saveTimer = null
        if (!_dirty || !_db) return
        try {
            const dir = join(process.cwd(), '.nova-data')
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            _db.lastSaved = new Date().toISOString()
            writeFileSync(getDbPath(), JSON.stringify(_db, null, 2))
            _dirty = false
        } catch (err) {
            console.log(`[ModelPerfDB] ⚠ Save failed: ${err}`)
        }
    }, SAVE_DEBOUNCE_MS)
}

// ============================================
// Auto-Disable Logic
// ============================================

const AUTO_DISABLE_CONSEC_FAILS = 5        // disable after this many consecutive failures
const AUTO_DISABLE_LOW_RATE_CALLS = 20     // need at least this many calls...
const AUTO_DISABLE_LOW_RATE_THRESHOLD = 0.2 // ...with <20% success to auto-disable
const AUTO_DISABLE_COOLDOWN_MS = 60 * 60 * 1000  // re-enable after 1 hour

/**
 * Check if a model is currently auto-disabled due to persistent failures.
 * Returns false once the cooldown has expired (model is re-enabled automatically).
 */
export function isModelDisabled(model: string): boolean {
    // In NovaOS gibt es meist genau EIN erreichbares Modell. Schaltet die
    // Leistungshistorie es ab, ist Nova komplett stumm — sie kann dann nicht
    // einmal mehr sagen, was los ist, und der Mensch sitzt vor einer toten
    // Kiste. Genau das ist passiert, nachdem ein zu kurzes Zeitlimit
    // (30 s im Desktop-Pfad) als Modellversagen gewertet wurde.
    // Ein Fehler in der Umgebung darf das Modell nicht dauerhaft sperren.
    if (process.env.NOVA_OS_MODE === 'true' && process.env.NOVA_ALLOW_MODEL_DISABLE !== '1') {
        return false
    }

    const db = loadDB()
    const e = db.entries[model]
    if (!e) return false

    if (e.disabledUntil) {
        const until = new Date(e.disabledUntil).getTime()
        if (Date.now() < until) {
            return true
        }
        // Cooldown expired — re-enable
        e.disabledUntil = null
        scheduleSave()
    }
    return false
}

/**
 * Manually re-enable a disabled model (e.g. after user intervention or config change).
 */
export function reenableModel(model: string): void {
    const db = loadDB()
    const e = db.entries[model]
    if (e) {
        e.disabledUntil = null
        e.consecutiveFails = 0
        scheduleSave()
        console.log(`[ModelPerfDB] ✅ Model re-enabled: ${model}`)
    }
}

/**
 * Return all currently disabled models with their re-enable time.
 */
export function getDisabledModels(): Array<{ model: string; disabledUntil: string; reason: string }> {
    const db = loadDB()
    const now = Date.now()
    return Object.values(db.entries)
        .filter(e => e.disabledUntil && new Date(e.disabledUntil).getTime() > now)
        .map(e => {
            const rate = e.totalCalls > 0 ? Math.round((e.totalSuccesses / e.totalCalls) * 100) : 0
            const reason = e.consecutiveFails >= AUTO_DISABLE_CONSEC_FAILS
                ? `${e.consecutiveFails} consecutive failures`
                : `${rate}% success rate over ${e.totalCalls} calls`
            return { model: e.model, disabledUntil: e.disabledUntil!, reason }
        })
}

function maybeAutoDisable(e: ModelPerfEntry): void {
    if (e.disabledUntil) return  // already disabled

    let shouldDisable = false
    let reason = ''

    if (e.consecutiveFails >= AUTO_DISABLE_CONSEC_FAILS) {
        shouldDisable = true
        reason = `${e.consecutiveFails} consecutive failures`
    } else if (e.totalCalls >= AUTO_DISABLE_LOW_RATE_CALLS) {
        const rate = e.totalSuccesses / e.totalCalls
        if (rate < AUTO_DISABLE_LOW_RATE_THRESHOLD) {
            shouldDisable = true
            reason = `${Math.round(rate * 100)}% success over ${e.totalCalls} calls`
        }
    }

    if (shouldDisable) {
        e.disabledUntil = new Date(Date.now() + AUTO_DISABLE_COOLDOWN_MS).toISOString()
        console.log(`[ModelPerfDB] 🚫 Auto-disabled ${e.model} for 1h: ${reason}`)
    }
}

// ============================================
// Core API
// ============================================

/**
 * Record a model call result.
 * Call this after every LLM request (success or fail).
 *
 * @param model       model id (e.g. 'Intel/Qwen3.5-122B-A10B-int4-AutoRound')
 * @param taskType    task category (e.g. 'chat', 'coding', 'simple-qa')
 * @param latencyMs   wall-clock time from request start to response (ms)
 * @param success     true = got a usable response, false = error/timeout/empty
 */
export function recordModelCall(
    model: string,
    taskType: string,
    latencyMs: number,
    success: boolean,
): void {
    if (!isModelPerformanceRecordingEnabled()) return
    const db = loadDB()
    if (!db.entries[model]) {
        db.entries[model] = {
            model,
            totalCalls: 0,
            totalSuccesses: 0,
            totalLatencyMs: 0,
            taskStats: {},
            consecutiveFails: 0,
            lastUpdated: new Date().toISOString(),
        }
    }

    const e = db.entries[model]
    e.totalCalls++
    e.totalLatencyMs += latencyMs
    if (success) {
        e.totalSuccesses++
        e.consecutiveFails = 0
    } else {
        e.consecutiveFails++
    }

    const task = taskType || 'unknown'
    if (!e.taskStats[task]) {
        e.taskStats[task] = { calls: 0, successes: 0, totalLatencyMs: 0 }
    }
    e.taskStats[task].calls++
    e.taskStats[task].totalLatencyMs += latencyMs
    if (success) e.taskStats[task].successes++

    e.lastUpdated = new Date().toISOString()
    maybeAutoDisable(e)
    scheduleSave()
}

/**
 * Get a routing score adjustment (-30 to +25) for a model/task combination.
 * This is applied ON TOP of the L18 Router's base score.
 *
 * Score logic:
 * +25  model has ≥80% success rate for this task (proven specialist)
 * +10  model has ≥60% success rate for this task
 *  0   no data yet (neutral)
 * -10  model has <40% success rate for this task (underperformer)
 * -20  model has ≥3 consecutive failures
 * -30  model is persistently broken (>10 calls, <20% success)
 */
export function getModelScoreAdjustment(model: string, taskType: string): number {
    const db = loadDB()
    const e = db.entries[model]
    if (!e || e.totalCalls < 3) return 0  // not enough data

    // Persistent failure penalty
    const overallRate = e.totalSuccesses / e.totalCalls
    if (e.totalCalls >= 10 && overallRate < 0.2) return -30
    if (e.consecutiveFails >= 3) return -20

    // Task-specific score
    const ts = e.taskStats[taskType]
    if (!ts || ts.calls < 2) {
        // Use overall rate as proxy
        if (overallRate >= 0.8) return +10
        if (overallRate < 0.4) return -10
        return 0
    }

    const taskRate = ts.successes / ts.calls
    if (taskRate >= 0.8) return +25
    if (taskRate >= 0.6) return +10
    if (taskRate < 0.4) return -10
    return 0
}

/**
 * Get a human-readable summary of top/bottom performers.
 * Used by /models and /status commands.
 */
export function getPerfSummary(): string {
    const db = loadDB()
    const entries = Object.values(db.entries).filter(e => e.totalCalls >= 3)
    if (entries.length === 0) return ''

    const sorted = entries.sort((a, b) => {
        const rateA = a.totalSuccesses / a.totalCalls
        const rateB = b.totalSuccesses / b.totalCalls
        return rateB - rateA
    })

    const now = Date.now()
    const lines: string[] = ['## Model Performance (Live)']
    for (const e of sorted.slice(0, 8)) {
        const rate = Math.round((e.totalSuccesses / e.totalCalls) * 100)
        const avgMs = Math.round(e.totalLatencyMs / e.totalCalls)
        const disabled = e.disabledUntil && new Date(e.disabledUntil).getTime() > now
        const status = disabled ? '🚫' : e.consecutiveFails >= 3 ? '⛔' : rate >= 80 ? '✅' : rate >= 50 ? '⚡' : '⚠️'
        const disabledNote = disabled ? ` [DISABLED until ${new Date(e.disabledUntil!).toLocaleTimeString()}]` : ''
        lines.push(`${status} **${e.model}**: ${rate}% success, ${avgMs}ms avg (${e.totalCalls} calls)${disabledNote}`)
    }
    return lines.join('\n')
}

/**
 * Get average latency for a model (ms). Returns undefined if not enough data.
 */
export function getAvgLatency(model: string): number | undefined {
    const db = loadDB()
    const e = db.entries[model]
    if (!e || e.totalCalls < 3) return undefined
    return Math.round(e.totalLatencyMs / e.totalCalls)
}

/**
 * Get all tracked models with their overall success rates.
 * Used for self-awareness prompt injection.
 */
export function getAllModelStats(): Array<{
    model: string
    successRate: number
    avgLatencyMs: number
    totalCalls: number
    consecutiveFails: number
}> {
    const db = loadDB()
    return Object.values(db.entries).map(e => ({
        model: e.model,
        successRate: e.totalCalls > 0 ? e.totalSuccesses / e.totalCalls : 0,
        avgLatencyMs: e.totalCalls > 0 ? Math.round(e.totalLatencyMs / e.totalCalls) : 0,
        totalCalls: e.totalCalls,
        consecutiveFails: e.consecutiveFails,
    }))
}

export default { recordModelCall, getModelScoreAdjustment, getPerfSummary, getAvgLatency, getAllModelStats, isModelDisabled, reenableModel, getDisabledModels }
