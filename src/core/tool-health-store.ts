/**
 * 2.89 (Paket C): THE one tool-health store.
 *
 * Before there were two, side by side and never reading each other:
 *  - layers/L15-self-check.ts kept tool health in `<cwd>/.nova-data/tool-health.json`
 *    (healthy / degraded / broken after 3 / 5 failures in a row),
 *  - memory/capabilities-store.ts kept "does not work on this machine" in
 *    `<cwd>/.nova-learning/unavailable.json` (from the 2nd failure on).
 * Both now read and write this one file in the data folder. The capability
 * inventory (learning/capability-inventory.ts) asks it whether a registered tool
 * really works.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getNovaDataDir } from './data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type ToolHealthStatus = 'healthy' | 'degraded' | 'broken'
export type ToolOutcome = 'success' | 'failure' | 'empty'

export interface ToolHealthEntry {
    name: string
    status: ToolHealthStatus
    successCount: number
    failureCount: number
    emptyResultCount: number
    consecutiveFailures: number
    consecutiveEmpty: number
    lastSuccess: number
    lastFailure: number
    lastDiagnosis: string | null
    repairedAt: number | null
    /** Last failure text (redacted) and a way out, for the owner's prompt. */
    reason?: string
    hint?: string
}

/** From the 2nd failure in a row a tool counts as "not working here" (one flaky call is no verdict). */
export const UNAVAILABLE_AFTER_FAILURES = 2
export const DEGRADED_AFTER = 3
export const BROKEN_AFTER = 5

export function toolHealthFile(): string { return getNovaDataDir('tool-health.json') }

export function loadToolHealth(): ToolHealthEntry[] {
    try {
        const file = toolHealthFile()
        if (!existsSync(file)) return []
        const data = JSON.parse(readFileSync(file, 'utf-8'))
        return Array.isArray(data) ? data.filter(item => item && typeof item.name === 'string') as ToolHealthEntry[] : []
    } catch { return [] }
}

function save(entries: ToolHealthEntry[]): void {
    try {
        const file = toolHealthFile()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(entries, null, 2))
    } catch { /* learning must never break a run */ }
}

function fresh(name: string): ToolHealthEntry {
    return {
        name, status: 'healthy', successCount: 0, failureCount: 0, emptyResultCount: 0, consecutiveFailures: 0, consecutiveEmpty: 0,
        lastSuccess: 0, lastFailure: 0, lastDiagnosis: null, repairedAt: null,
    }
}

export interface OutcomeDetail { reason?: string; hint?: string }

/** Record one outcome; returns the entry and the status before (for events). */
export function recordToolOutcome(name: string, outcome: ToolOutcome, detail: OutcomeDetail = {}, now = Date.now()): { entry: ToolHealthEntry; before: ToolHealthStatus } {
    const entries = loadToolHealth()
    let entry = entries.find(item => item.name === name)
    if (!entry) { entry = fresh(name); entries.push(entry) }
    const before = entry.status
    if (outcome === 'success') {
        entry.successCount++
        entry.lastSuccess = now
        entry.consecutiveFailures = 0
        entry.consecutiveEmpty = 0
        if (entry.status !== 'healthy') { entry.status = 'healthy'; entry.repairedAt = now }
        entry.reason = undefined
    } else if (outcome === 'failure') {
        entry.failureCount++
        entry.lastFailure = now
        entry.consecutiveFailures++
        if (detail.reason) entry.reason = redactSecrets(detail.reason).slice(0, 300)
        if (detail.hint) entry.hint = detail.hint
        if (entry.consecutiveFailures >= BROKEN_AFTER) {
            entry.status = 'broken'
            entry.lastDiagnosis = `${entry.consecutiveFailures} consecutive failures since ${new Date(entry.lastSuccess || now).toISOString()}`
        } else if (entry.consecutiveFailures >= DEGRADED_AFTER) {
            entry.status = 'degraded'
        }
    } else {
        entry.emptyResultCount++
        entry.consecutiveEmpty++
        if (entry.consecutiveEmpty >= BROKEN_AFTER) {
            entry.status = 'broken'
            entry.lastDiagnosis = `${entry.consecutiveEmpty} consecutive empty results — tool likely blocked or misconfigured`
        } else if (entry.consecutiveEmpty >= DEGRADED_AFTER) {
            entry.status = 'degraded'
            entry.lastDiagnosis = `${entry.consecutiveEmpty} empty results in a row`
        }
    }
    save(entries)
    return { entry, before }
}

/** Owner fixed it (installed the missing package): forget the failures. */
export function clearToolFailures(name: string, now = Date.now()): void {
    const entries = loadToolHealth()
    const entry = entries.find(item => item.name === name)
    if (!entry || (entry.consecutiveFailures === 0 && entry.status === 'healthy')) return
    entry.consecutiveFailures = 0
    entry.consecutiveEmpty = 0
    entry.status = 'healthy'
    entry.repairedAt = now
    entry.reason = undefined
    save(entries)
}

/** The one verdict "this tool does not work on this machine right now". */
export function isToolUnavailable(entry: Pick<ToolHealthEntry, 'status' | 'consecutiveFailures'>): boolean {
    return entry.status !== 'healthy' || entry.consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES
}

export function unavailableTools(): ToolHealthEntry[] {
    return loadToolHealth().filter(isToolUnavailable)
}

/**
 * A failure text arrives from a second path (the runner, owner runs only) for a call the tool
 * registry has just counted. Within the dedupe window it only adds reason and hint; otherwise it
 * counts as a failure of its own. One call never counts twice.
 */
export function noteToolFailure(name: string, detail: OutcomeDetail, now = Date.now(), dedupeMs = 1_500): ToolHealthEntry {
    const entries = loadToolHealth()
    const entry = entries.find(item => item.name === name)
    if (entry && entry.lastFailure > 0 && now - entry.lastFailure <= dedupeMs) {
        if (detail.reason) entry.reason = redactSecrets(detail.reason).slice(0, 300)
        if (detail.hint) entry.hint = detail.hint
        save(entries)
        return entry
    }
    return recordToolOutcome(name, 'failure', detail, now).entry
}
