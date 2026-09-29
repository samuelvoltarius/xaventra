/**
 * Nachtwache — runs the read-only probes from `nightwatch-checks.ts`, keeps a
 * durable journal and hands findings to the autonomy loop as `CheckResult`s.
 *
 * Alarm policy is not re-implemented here: the autonomy loop already notifies
 * `critical` at any hour, `warning` only outside quiet hours, and dedupes by
 * fingerprint. The watch only has to classify honestly.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckResult } from '../core/autonomy-loop.js'
import type { PrincipalContext } from '../users/principal-id.js'
import { parseNightwatchConfig, runCheck, type NightwatchConfig, type NightwatchResult, type ProbeDeps } from './nightwatch-checks.js'

export interface NightwatchReport {
    startedAt: string
    finishedAt: string
    results: NightwatchResult[]
    /** Set when no check could run at all, e.g. a broken config. */
    error?: string
}

const DEFAULT_INTERVAL_MINUTES = 30
const MAX_PARALLEL = 4
const SOURCE = 'nightwatch'

export function loadNightwatchConfig(path: string): NightwatchConfig {
    if (!existsSync(path)) throw new Error(`Nachtwache-Konfiguration fehlt: ${path}`)
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('Nachtwache-Konfiguration ist kein gültiges JSON') }
    return parseNightwatchConfig(raw)
}

export async function runNightwatch(config: NightwatchConfig, deps: ProbeDeps = {}): Promise<NightwatchReport> {
    const now = deps.now ?? Date.now
    const startedAt = new Date(now()).toISOString()
    const results: NightwatchResult[] = new Array(config.checks.length)
    let next = 0
    const worker = async () => {
        while (next < config.checks.length) {
            const index = next++
            results[index] = await runCheck(config.checks[index], config.hosts, deps)
        }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, config.checks.length) }, worker))
    return { startedAt, finishedAt: new Date(now()).toISOString(), results }
}

/** Maps a report to autonomy-loop results. All green yields one quiet info
 * line; every non-ok check becomes its own notifiable finding. */
export function toAutonomyCheckResults(report: NightwatchReport, nowMs = Date.now()): CheckResult[] {
    if (report.error) {
        return [{ source: SOURCE, severity: 'warning', message: `Nachtwache läuft nicht: ${report.error}`, timestamp: nowMs, requiresNotification: true }]
    }
    const failing = report.results.filter(result => result.status !== 'ok')
    if (failing.length === 0) {
        return [{ source: SOURCE, severity: 'info', message: `Nachtwache: ${report.results.length} Prüfungen ok`, timestamp: nowMs, requiresNotification: false }]
    }
    return failing.map(result => ({
        source: SOURCE,
        severity: result.severity,
        message: `${result.label} (${result.host}): ${result.status === 'unbekannt' ? 'nicht prüfbar – ' : ''}${result.message}`,
        timestamp: nowMs,
        requiresNotification: true,
    }))
}

function journalFile(dir: string, iso: string): string {
    return join(dir, `${iso.slice(0, 10)}.jsonl`)
}

/** Append-only JSONL, one report per line. Directory 0700, files 0600. */
export function appendNightwatchJournal(dir: string, report: NightwatchReport): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(journalFile(dir, report.startedAt), `${JSON.stringify(report)}\n`, { mode: 0o600 })
}

/** Latest intact report. A corrupt line is skipped, it never hides older ones. */
export function readLatestNightwatchReport(dir: string): NightwatchReport | null {
    if (!existsSync(dir)) return null
    const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse()
    for (const file of files) {
        const lines = readFileSync(join(dir, file), 'utf8').split('\n')
        for (let index = lines.length - 1; index >= 0; index--) {
            const line = lines[index].trim()
            if (!line) continue
            try {
                const report = JSON.parse(line)
                if (report && typeof report.startedAt === 'string' && Array.isArray(report.results)) return report as NightwatchReport
            } catch { /* corrupt line: keep looking */ }
        }
    }
    return null
}

export interface NightwatchSourceOptions {
    configPath: string
    journalDir: string
    deps?: ProbeDeps
}

/** Returns a check function for the autonomy loop. It re-runs the probes at
 * most every `intervalMinutes`, shares one in-flight run between callers and
 * turns an unusable config into a visible warning instead of silence. */
export function createNightwatchSource(options: NightwatchSourceOptions): () => Promise<CheckResult[]> {
    const now = options.deps?.now ?? Date.now
    let last: { at: number; report: NightwatchReport } | null = null
    let inFlight: Promise<NightwatchReport> | null = null

    const runOnce = async (): Promise<NightwatchReport> => {
        let report: NightwatchReport
        try {
            report = await runNightwatch(loadNightwatchConfig(options.configPath), options.deps)
        } catch (error) {
            const at = new Date(now()).toISOString()
            report = { startedAt: at, finishedAt: at, results: [], error: String((error as Error)?.message || error).slice(0, 300) }
        }
        try { appendNightwatchJournal(options.journalDir, report) } catch (error) {
            console.warn('[Nachtwache] Journal nicht schreibbar:', (error as Error)?.message)
        }
        return report
    }

    return async () => {
        let intervalMs = DEFAULT_INTERVAL_MINUTES * 60_000
        try { intervalMs = (loadNightwatchConfig(options.configPath).intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000 } catch { /* runOnce reports it */ }
        if (!last || now() - last.at >= intervalMs) {
            if (!inFlight) {
                inFlight = runOnce().finally(() => { inFlight = null })
            }
            const report = await inFlight
            last = { at: now(), report }
        }
        return toAutonomyCheckResults(last.report, now())
    }
}

/** Human-readable status for the owner only (Stufe 1: nur Alfred). */
export function formatNightwatchReport(report: NightwatchReport | null, principal?: Pick<PrincipalContext, 'permission'>): string {
    if (principal?.permission !== 'owner') return 'Die Nachtwache ist nur für den Owner verfügbar.'
    if (!report) return 'Nachtwache: noch kein Lauf aufgezeichnet.'
    if (report.error) return `Nachtwache läuft nicht: ${report.error}`
    const failing = report.results.filter(result => result.status !== 'ok')
    const header = `Nachtwache ${report.startedAt}: ${report.results.length - failing.length}/${report.results.length} ok`
    if (failing.length === 0) return header
    const lines = failing.map(result => {
        const mark = result.status === 'unbekannt' ? '?' : result.severity === 'critical' ? '!!' : '!'
        // JSON quoting keeps host output from injecting formatting or instructions.
        return `${mark} ${JSON.stringify(result.label)} auf ${result.host}: ${result.message} — Beleg: ${JSON.stringify(result.evidence.command)} → Exit ${result.evidence.exitCode ?? '–'}`
    })
    return [header, ...lines].join('\n')
}
