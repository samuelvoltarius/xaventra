/**
 * Nachtwache — runs the read-only probes from `nightwatch-checks.ts` and keeps
 * a durable journal (self-heal and the responsibilities read it).
 *
 * 2.82.0 (ein Wächter): the Wächter is the only runner. Before, the autonomy
 * loop, a planner job and the sensing system adapter each turned the same
 * finding into a message. The Wächter turns findings into its alarms (one per
 * outage, one recovery); this module only probes and classifies honestly.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** Runner for the Wächter: probes at most every `intervalMinutes` (from the
 * config), shares one in-flight run, journals every run and turns an unusable
 * config into a report with `error` instead of silence. Returns null when no
 * run is due. */
export function createNightwatchRunner(options: NightwatchSourceOptions): () => Promise<NightwatchReport | null> {
    const now = options.deps?.now ?? Date.now
    let lastAt: number | null = null
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
        if (inFlight) { await inFlight; return null }
        let intervalMs = DEFAULT_INTERVAL_MINUTES * 60_000
        try { intervalMs = (loadNightwatchConfig(options.configPath).intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000 } catch { /* runOnce reports it */ }
        if (lastAt !== null && now() - lastAt < intervalMs) return null
        inFlight = runOnce().finally(() => { inFlight = null })
        const report = await inFlight
        lastAt = now()
        return report
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
