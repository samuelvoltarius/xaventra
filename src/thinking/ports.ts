/**
 * Phase 3 „Denken" — gemeinsame Ports, Gedanken-Typ und Einstellungen.
 *
 * PORTS (für die Integration in Planer und Karten, Phase 1):
 *
 * - `ThoughtSink` — einziger Ausgang aller Denk-Module. Jedes Ergebnis
 *   (Idee, Modell-Vorschlag, Bug-Fall, „Immer erlauben?") ist ein `Thought`
 *   und geht NUR hierhin. Kein Denk-Modul sendet selbst an Telegram, einen
 *   Notifier oder schaltet etwas. Standard: `JsonlThoughtSink` hängt an
 *   `<data>/.nova-data/thinking/thoughts.jsonl` an (0600, Secrets geschwärzt).
 *   Die Integration ersetzt ihn durch den Gedanken-Speicher des Planers
 *   (`/gedanken`) und baut aus `stufe: 'fragen'` + `proposal` die Knopf-Karte.
 *   `proposal.autoExecute` ist immer `false`: ausgeführt wird erst nach einem
 *   Owner-Knopf, und das Ticket erzeugt der Code der Karten, nie dieses Modul.
 *
 * - `Schedule` — Zeitsteuerung der Läufe (`ideas`, `scout`, `bugs`).
 *   Standard: `IntervalSchedule` = einfache Intervalle, im Autonomy-Loop pro
 *   Zyklus abgefragt (Ideen 20 h, Scout 7 Tage, Bugs 1 h; Zustand in
 *   `<data>/.nova-data/thinking/schedule.json`). Abschaltbar über
 *   `autonomy.thinking.enabled` bzw. den Schalter je Teil. Die Integration kann
 *   ihn durch Jobs des Planers ersetzen (gleiche drei Methoden).
 *
 * - `LoadProbe` — misst GPU-/vLLM-Last (nvidia-smi `utilization.gpu`, vLLM
 *   `/metrics` Warteschlange). Nicht messbar = ausgelastet (fail closed):
 *   STUFENPLAN Grenze 6, nie schwere Last neben vLLM (OOM 13.09.).
 */
import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { defaultOn } from '../core/autonomy-defaults.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

// ---------------------------------------------------------------------------
// Gedanke
// ---------------------------------------------------------------------------

/** Erlaubnisstufe (Autonomie-Plan F): selbst / fragen / nie. */
export type ThoughtStufe = 'selbst' | 'fragen' | 'nie'
/** `neu`: wartet auf Owner; `info`: nur sichtbar; `verworfen`: bewusst nicht vorgeschlagen. */
export type ThoughtStatus = 'neu' | 'info' | 'verworfen'
export type ThoughtSource = 'ideen-lauf' | 'modell-scout' | 'bug-finder' | 'lernen'

export interface ThoughtEvidence {
    metric: string
    value: number | string
    unit?: string
    /** Woher die Zahl stammt (z. B. "traces 7 Tage, 412 Läufe"). */
    source: string
}

export interface ThoughtProposal {
    action: string
    params?: Record<string, string | number>
    /** Denk-Module führen nie aus. Ausführung nur nach Knopf + Ticket der Karten. */
    autoExecute: false
}

export interface Thought {
    id: string
    createdAt: string
    source: ThoughtSource
    /** Art für Lernen/Entprellen (z. B. "idee:werkzeug-langsam"). */
    kind: string
    title: string
    text: string
    evidence: ThoughtEvidence[]
    /** Messbares Ziel (nur Ideen-Lauf, Pflicht dort). */
    target?: string
    importance: number
    proposal?: ThoughtProposal
    stufe: ThoughtStufe
    status: ThoughtStatus
    dedupeKey: string
    report?: unknown
}

export interface ThoughtSink {
    emit(thought: Thought): Promise<void>
}

const clipText = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max)

/** Schwärzt und begrenzt alle Textfelder eines Gedankens, bevor er die Module verlässt. */
export function sanitizeThought(thought: Thought): Thought {
    return {
        ...thought,
        kind: clipText(thought.kind, 120),
        title: clipText(thought.title, 200),
        text: clipText(thought.text, 2_000),
        target: thought.target === undefined ? undefined : clipText(thought.target, 300),
        importance: Math.max(0, Math.min(1, Number.isFinite(thought.importance) ? thought.importance : 0)),
        evidence: thought.evidence.slice(0, 10).map(item => ({
            metric: clipText(item.metric, 80), source: clipText(item.source, 200),
            value: typeof item.value === 'number' ? item.value : clipText(item.value, 200),
            ...(item.unit ? { unit: clipText(item.unit, 20) } : {}),
        })),
        proposal: thought.proposal ? { ...thought.proposal, action: clipText(thought.proposal.action, 60), autoExecute: false } : undefined,
    }
}

/** Standard-Port: JSONL unter dem Datenverzeichnis. */
export class JsonlThoughtSink implements ThoughtSink {
    constructor(private readonly path = getNovaDataDir('thinking', 'thoughts.jsonl')) {}
    async emit(thought: Thought): Promise<void> {
        mkdirSync(dirname(this.path), { recursive: true })
        appendFileSync(this.path, `${JSON.stringify(sanitizeThought(thought))}\n`, { mode: 0o600 })
        try { chmodSync(this.path, 0o600) } catch { /* Windows */ }
    }
}

/** Für Tests und für die Integration (Puffer vor dem Planer). */
export class MemoryThoughtSink implements ThoughtSink {
    readonly thoughts: Thought[] = []
    async emit(thought: Thought): Promise<void> { this.thoughts.push(sanitizeThought(thought)) }
}

let thoughtCounter = 0
export function newThoughtId(source: ThoughtSource, now: Date): string {
    thoughtCounter = (thoughtCounter + 1) % 1_000_000
    return `${source}-${now.getTime().toString(36)}-${thoughtCounter.toString(36)}`
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type ThinkingJob = 'ideas' | 'scout' | 'bugs'

export interface Schedule {
    isDue(job: ThinkingJob, now: Date): boolean
    /** Lauf erledigt: nächster Lauf nach dem Intervall. */
    markRan(job: ThinkingJob, now: Date): void
    /** Lauf verschoben (z. B. GPU belegt): frühestens nach `ms` erneut. */
    defer(job: ThinkingJob, now: Date, ms: number): void
}

export const DEFAULT_INTERVALS_MS: Readonly<Record<ThinkingJob, number>> = Object.freeze({
    ideas: 20 * 60 * 60_000,
    scout: 7 * 24 * 60 * 60_000,
    bugs: 60 * 60_000,
})

export class IntervalSchedule implements Schedule {
    private next: Partial<Record<ThinkingJob, number>> = {}
    constructor(
        private readonly path = getNovaDataDir('thinking', 'schedule.json'),
        private readonly intervals: Record<ThinkingJob, number> = { ...DEFAULT_INTERVALS_MS },
    ) {
        try { if (existsSync(path)) this.next = JSON.parse(readFileSync(path, 'utf8')).next || {} } catch { this.next = {} }
    }
    isDue(job: ThinkingJob, now: Date): boolean { return now.getTime() >= (this.next[job] ?? 0) }
    markRan(job: ThinkingJob, now: Date): void { this.set(job, now.getTime() + this.intervals[job]) }
    defer(job: ThinkingJob, now: Date, ms: number): void { this.set(job, now.getTime() + Math.max(60_000, ms)) }
    private set(job: ThinkingJob, at: number): void {
        this.next[job] = at
        try { mkdirSync(dirname(this.path), { recursive: true }); atomicWriteJsonSync(this.path, { version: 1, next: this.next }) } catch { /* nächster Zyklus */ }
    }
}

// ---------------------------------------------------------------------------
// LoadProbe — Messung, nicht Annahme
// ---------------------------------------------------------------------------

export interface LoadSample {
    /** Mindestens eine Quelle hat gemessen. */
    measured: boolean
    gpuUtilPercent?: number
    vllmRunning?: number
    vllmWaiting?: number
    sources: string[]
    error?: string
}

export interface LoadProbe {
    sample(): Promise<LoadSample>
}

export function parseVllmMetrics(text: string): { running: number; waiting: number } | null {
    let running: number | null = null, waiting: number | null = null
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue
        const match = /^vllm:num_requests_(running|waiting)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/.exec(line.trim())
        if (!match) continue
        const value = Number(match[2])
        if (!Number.isFinite(value)) continue
        if (match[1] === 'running') running = (running ?? 0) + value
        else waiting = (waiting ?? 0) + value
    }
    return running === null && waiting === null ? null : { running: running ?? 0, waiting: waiting ?? 0 }
}

/** Ruhig = gemessen, GPU ≤ Schwelle und keine vLLM-Anfrage in Arbeit oder Warteschlange. */
export function judgeLoad(sample: LoadSample, settings: Pick<ThinkingSettings['load'], 'maxGpuUtilPercent' | 'vllmMetricsUrl'>): { idle: boolean; reason: string } {
    if (!sample.measured) return { idle: false, reason: `Last nicht messbar (${sample.error || 'keine Quelle'}) — gilt als ausgelastet` }
    if (settings.vllmMetricsUrl && sample.vllmRunning === undefined) return { idle: false, reason: 'vLLM-Last nicht messbar — gilt als ausgelastet' }
    if (sample.gpuUtilPercent !== undefined && sample.gpuUtilPercent > settings.maxGpuUtilPercent) {
        return { idle: false, reason: `GPU ausgelastet (${sample.gpuUtilPercent} % > ${settings.maxGpuUtilPercent} %)` }
    }
    const queue = (sample.vllmRunning ?? 0) + (sample.vllmWaiting ?? 0)
    if (queue > 0) return { idle: false, reason: `vLLM arbeitet (${sample.vllmRunning ?? 0} laufend, ${sample.vllmWaiting ?? 0} wartend)` }
    return { idle: true, reason: `ruhig (GPU ${sample.gpuUtilPercent ?? '–'} %, vLLM-Warteschlange ${queue})` }
}

const validUtil = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100

function nvidiaSmiUtil(timeoutMs: number): Promise<number | null> {
    return new Promise(resolve => {
        try {
            execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { shell: false, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
                if (error) return resolve(null)
                const values = String(stdout || '').split(/\r?\n/).map(line => Number(line.trim())).filter(validUtil)
                resolve(values.length ? Math.max(...values) : null)
            })
        } catch { resolve(null) }
    })
}

/**
 * Standard-Messung: nvidia-smi (ohne Shell, Zeitlimit) und, wenn konfiguriert,
 * vLLM `/metrics`. Mehrere Proben im Abstand, der höchste Wert zählt — eine
 * einzelne Probe verpasst kurze Lastspitzen.
 */
export function createDefaultLoadProbe(options: { vllmMetricsUrl?: string; samples?: number; spacingMs?: number; timeoutMs?: number } = {}): LoadProbe {
    const samples = Math.max(1, Math.min(5, options.samples ?? 3))
    const spacingMs = options.spacingMs ?? 2_000
    const timeoutMs = options.timeoutMs ?? 5_000
    return {
        async sample() {
            const result: LoadSample = { measured: false, sources: [] }
            const errors: string[] = []
            for (let i = 0; i < samples; i++) {
                if (i > 0) await new Promise(done => setTimeout(done, spacingMs))
                const util = await nvidiaSmiUtil(timeoutMs)
                if (util !== null) {
                    result.gpuUtilPercent = Math.max(result.gpuUtilPercent ?? 0, util)
                    if (!result.sources.includes('nvidia-smi')) result.sources.push('nvidia-smi')
                } else if (!errors.includes('nvidia-smi')) errors.push('nvidia-smi')
                if (options.vllmMetricsUrl) {
                    try {
                        const response = await fetch(`${options.vllmMetricsUrl.replace(/\/+$/, '')}/metrics`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
                        const parsed = response.ok ? parseVllmMetrics(await response.text()) : null
                        if (parsed) {
                            result.vllmRunning = Math.max(result.vllmRunning ?? 0, parsed.running)
                            result.vllmWaiting = Math.max(result.vllmWaiting ?? 0, parsed.waiting)
                            if (!result.sources.includes('vllm')) result.sources.push('vllm')
                        } else if (!errors.includes('vllm')) errors.push('vllm')
                    } catch { if (!errors.includes('vllm')) errors.push('vllm') }
                }
            }
            result.measured = result.sources.length > 0
            if (errors.length) result.error = `nicht messbar: ${errors.join(', ')}`
            return result
        },
    }
}

// ---------------------------------------------------------------------------
// Einstellungen: autonomy.thinking (P8: am Main standardmäßig AN, `false` schaltet ab; Worker aus)
// ---------------------------------------------------------------------------

export type ScoutSourceConfig =
    | { type: 'huggingface'; url?: string; limit?: number; timeoutMs?: number }
    | { type: 'fixture'; path: string }

export interface ThinkingSettings {
    enabled: boolean
    ideas: { enabled: boolean; nightStartHour: number; nightEndHour: number; maxPerDay: number; dedupeDays: number }
    scout: {
        enabled: boolean; sources: ScoutSourceConfig[]; memoryBudgetGB?: number; licenses: string[]
        minImprovementPercent: number; currentModel?: string; maxCandidates: number
    }
    bugFinder: { enabled: boolean; minOccurrences: number; windowDays: number; maxNewCasesPerRun: number }
    learning: { enabled: boolean; alwaysAllowAfter: number }
    load: { maxGpuUtilPercent: number; vllmMetricsUrl?: string }
}

/** Feste Obergrenze aus dem Autonomie-Plan (D): höchstens 3 Ideen pro Tag. */
export const MAX_IDEAS_PER_DAY = 3
/** Feste Untergrenze aus dem Autonomie-Plan (G): frühestens nach 5× „Ja". */
export const MIN_YES_FOR_ALWAYS_ALLOW = 5

export const DEFAULT_SCOUT_LICENSES: readonly string[] = Object.freeze([
    'apache-2.0', 'mit', 'bsd-3-clause', 'llama3.1', 'llama3.2', 'llama3.3', 'llama4', 'gemma', 'qwen',
])

const num = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}
const obj = (value: unknown): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {})
const plainUrl = (value: unknown): string | undefined => {
    try {
        const url = new URL(String(value || ''))
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString().replace(/\/+$/, '') : undefined
    } catch { return undefined }
}

export function parseThinkingSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env): ThinkingSettings {
    const root = obj(raw)
    const master = defaultOn(root.enabled, env)
    const part = (key: string) => master && defaultOn(obj(root[key]).enabled, env)
    const ideas = obj(root.ideas), scout = obj(root.scout), bug = obj(root.bugFinder), learning = obj(root.learning), load = obj(root.load)
    const sources: ScoutSourceConfig[] = (Array.isArray(scout.sources) ? scout.sources : []).flatMap((item: any): ScoutSourceConfig[] => {
        if (item?.type === 'huggingface') {
            const url = item.url === undefined ? undefined : plainUrl(item.url)
            if (item.url !== undefined && !url) return []
            return [{ type: 'huggingface', url, limit: num(item.limit, 50, 1, 200), timeoutMs: num(item.timeoutMs, 10_000, 1_000, 30_000) }]
        }
        if (item?.type === 'fixture' && typeof item.path === 'string' && item.path) return [{ type: 'fixture', path: item.path }]
        return []
    })
    const licenses = Array.isArray(scout.licenses) && scout.licenses.length
        ? scout.licenses.map((value: unknown) => String(value).toLowerCase().trim()).filter(Boolean)
        : [...DEFAULT_SCOUT_LICENSES]
    return {
        enabled: master,
        ideas: {
            enabled: part('ideas'),
            nightStartHour: num(ideas.nightStartHour, 1, 0, 23),
            nightEndHour: num(ideas.nightEndHour, 5, 0, 23),
            maxPerDay: num(ideas.maxPerDay, MAX_IDEAS_PER_DAY, 0, MAX_IDEAS_PER_DAY),
            dedupeDays: num(ideas.dedupeDays, 7, 1, 90),
        },
        scout: {
            enabled: part('scout'), sources,
            memoryBudgetGB: scout.memoryBudgetGB === undefined ? undefined : num(scout.memoryBudgetGB, 0, 0, 4096),
            licenses,
            minImprovementPercent: num(scout.minImprovementPercent, 5, 1, 100),
            currentModel: typeof scout.currentModel === 'string' && scout.currentModel ? scout.currentModel.slice(0, 200) : undefined,
            maxCandidates: num(scout.maxCandidates, 3, 1, 5),
        },
        bugFinder: {
            enabled: part('bugFinder'),
            minOccurrences: num(bug.minOccurrences, 5, 2, 1000),
            windowDays: num(bug.windowDays, 7, 1, 14),
            maxNewCasesPerRun: num(bug.maxNewCasesPerRun, 3, 1, 10),
        },
        learning: { enabled: part('learning'), alwaysAllowAfter: num(learning.alwaysAllowAfter, MIN_YES_FOR_ALWAYS_ALLOW, MIN_YES_FOR_ALWAYS_ALLOW, 100) },
        load: { maxGpuUtilPercent: num(load.maxGpuUtilPercent, 20, 0, 100), vllmMetricsUrl: load.vllmMetricsUrl === undefined ? undefined : plainUrl(load.vllmMetricsUrl) },
    }
}

/** Lokales Kalenderdatum (für Tagesgrenzen). */
export function localDay(now: Date): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
