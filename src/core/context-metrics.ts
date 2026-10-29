/**
 * 2.90.0 Messung „Kontext je Aufgabe“: one line per agent turn.
 *
 * Before 2.90 only `systemPrompt size` was logged; the runner adds more system
 * messages, up to 12 000 characters of history and the tool schemas, so the
 * real model input was unknown (C-Messung 28.10.: 25 of 46 Telegram turns cut
 * to 12 000). Stored are sizes, counts and block headings only — never the
 * request text or tool results.
 *
 * File: .nova-data/context-metrics.jsonl (rotated to .1). Owner view: /kontext.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from './data-root.js'
import { sideEffectsDisabled } from './side-effects.js'
import { contextSwitch } from './context-switches.js'

export interface ModelInputStats {
    modelInputChars: number
    systemChars: number
    systemMessages: number
    historyChars: number
    historyMessages: number
    toolSchemaChars: number
    toolsOffered: number
}

export interface ContextTurnMetrics {
    at: string
    traceId?: string
    channel: string
    mode: string
    taskClass?: string
    promptRawChars: number
    promptSentChars: number
    promptCap: number
    capped: boolean
    cappedBlocks: number
    /** Headings the cap trimmed or dropped (at most 40). */
    reducedHeadings?: string[]
    modelInputChars?: number
    systemChars?: number
    historyChars?: number
    toolSchemaChars?: number
    toolsOffered?: number
    modelCalls?: number
    maxModelInputChars?: number
    toolCalls?: number
    selfInfoCalls?: number
    outcome?: 'answer' | 'incomplete' | 'error'
    durationMs?: number
    taskPromptMode?: string
    taskPromptChars?: number
    taskPromptWouldCap?: boolean
    taskPromptTopics?: string[]
    taskPromptOmitted?: number
    /** Headings the cap cut that the task prompt keeps in full. */
    taskPromptRescued?: string[]
    taskPromptUntagged?: string[]
    lagebildMode?: string
    lagebildChars?: number
}

const FILE = 'context-metrics.jsonl'
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const HEADINGS_MAX = 40

const textOf = (content: unknown): string => typeof content === 'string' ? content : JSON.stringify(content ?? '')

/** Size of what really goes to the model: every message plus the tool schemas. */
export function measureModelInput(
    messages: ReadonlyArray<{ role: string; content: unknown }>,
    tools: ReadonlyArray<unknown> = [],
): ModelInputStats {
    let systemChars = 0, systemMessages = 0, historyChars = 0, historyMessages = 0
    for (const message of messages) {
        const size = textOf(message.content).length
        if (message.role === 'system') { systemChars += size; systemMessages++ }
        else { historyChars += size; historyMessages++ }
    }
    const toolSchemaChars = tools.length ? JSON.stringify(tools).length : 0
    return {
        modelInputChars: systemChars + historyChars + toolSchemaChars,
        systemChars, systemMessages, historyChars, historyMessages, toolSchemaChars, toolsOffered: tools.length,
    }
}

const KEYS: ReadonlyArray<keyof ContextTurnMetrics> = [
    'at', 'traceId', 'channel', 'mode', 'taskClass', 'promptRawChars', 'promptSentChars', 'promptCap', 'capped', 'cappedBlocks',
    'reducedHeadings', 'modelInputChars', 'systemChars', 'historyChars', 'toolSchemaChars', 'toolsOffered', 'modelCalls',
    'maxModelInputChars', 'toolCalls', 'selfInfoCalls', 'outcome', 'durationMs', 'taskPromptMode', 'taskPromptChars',
    'taskPromptWouldCap', 'taskPromptTopics', 'taskPromptOmitted', 'taskPromptRescued', 'taskPromptUntagged', 'lagebildMode', 'lagebildChars',
]

/** Only known fields; heading lists bounded. */
function sanitize(entry: ContextTurnMetrics): ContextTurnMetrics {
    const out: Record<string, unknown> = {}
    for (const key of KEYS) {
        const value = (entry as any)[key]
        if (value === undefined) continue
        out[key] = Array.isArray(value) ? value.slice(0, HEADINGS_MAX).map(item => String(item).slice(0, 120)) : value
    }
    return out as unknown as ContextTurnMetrics
}

export function recordContextMetrics(
    entry: ContextTurnMetrics,
    options: { dir?: string; env?: NodeJS.ProcessEnv; maxBytes?: number } = {},
): boolean {
    if (contextSwitch('metrics', { env: options.env }) === 'off') return false
    if (!options.dir && sideEffectsDisabled()) return false
    const dir = options.dir ?? getNovaDataDir()
    const path = join(dir, FILE)
    try {
        mkdirSync(dir, { recursive: true })
        const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
        if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)
        appendFileSync(path, `${JSON.stringify(sanitize(entry))}\n`)
        return true
    } catch (error) {
        console.debug('[ContextMetrics] write failed:', error)
        return false
    }
}

/** Newest last; `limit` keeps the newest entries. */
export function readContextMetrics(options: { dir?: string; limit?: number } = {}): ContextTurnMetrics[] {
    const path = join(options.dir ?? getNovaDataDir(), FILE)
    if (!existsSync(path)) return []
    const entries: ContextTurnMetrics[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { entries.push(JSON.parse(line)) } catch { /* a torn line is skipped */ }
    }
    return options.limit ? entries.slice(-options.limit) : entries
}

function median(values: number[]): number {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export interface ContextMetricsSummary {
    turns: number
    capped: number
    capRatePercent: number
    medianPromptRawChars: number
    medianPromptSentChars: number
    medianModelInputChars: number
    medianToolCalls: number
    maxSelfInfoCalls: number
    taskPromptTurns: number
    medianTaskPromptChars: number
    taskPromptWouldCap: number
    /** Headings the cap cut most often. */
    topReduced: Array<{ heading: string; count: number }>
}

export function summarizeContextMetrics(entries: readonly ContextTurnMetrics[]): ContextMetricsSummary {
    const capped = entries.filter(entry => entry.capped).length
    const numbers = (pick: (entry: ContextTurnMetrics) => number | undefined) =>
        entries.map(pick).filter((value): value is number => typeof value === 'number')
    const task = entries.filter(entry => typeof entry.taskPromptChars === 'number')
    const reduced = new Map<string, number>()
    for (const entry of entries) for (const heading of entry.reducedHeadings ?? []) reduced.set(heading, (reduced.get(heading) ?? 0) + 1)
    return {
        turns: entries.length,
        capped,
        capRatePercent: entries.length ? Math.round((capped / entries.length) * 100) : 0,
        medianPromptRawChars: median(numbers(entry => entry.promptRawChars)),
        medianPromptSentChars: median(numbers(entry => entry.promptSentChars)),
        medianModelInputChars: median(numbers(entry => entry.modelInputChars)),
        medianToolCalls: median(numbers(entry => entry.toolCalls)),
        maxSelfInfoCalls: Math.max(0, ...numbers(entry => entry.selfInfoCalls)),
        taskPromptTurns: task.length,
        medianTaskPromptChars: median(task.map(entry => entry.taskPromptChars as number)),
        taskPromptWouldCap: task.filter(entry => entry.taskPromptWouldCap).length,
        topReduced: [...reduced].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([heading, count]) => ({ heading, count })),
    }
}

const k = (chars: number) => `${(chars / 1000).toFixed(1)}k`

/** /kontext: short owner overview of the last turns. */
export function formatKontext(entries: readonly ContextTurnMetrics[]): string {
    if (!entries.length) return '📏 Noch keine Kontext-Messung (sie entsteht bei jedem Zug mit Modell).'
    const s = summarizeContextMetrics(entries)
    const lines = [
        `📏 *Kontext der letzten ${s.turns === 1 ? '1 Zug' :`${s.turns} Züge`}*`,
        `Gekappt: ${s.capped} von ${s.turns} (${s.capRatePercent} %)`,
        `Systemprompt Median: ${k(s.medianPromptRawChars)} gebaut → ${k(s.medianPromptSentChars)} gesendet`,
        s.medianModelInputChars ? `Ganze Modelleingabe Median: ${k(s.medianModelInputChars)} Zeichen` : '',
        `Werkzeugaufrufe Median: ${s.medianToolCalls} · Selbstauskunft höchstens ${s.maxSelfInfoCalls}× in einem Zug`,
        s.taskPromptTurns ? `Aufgaben-Prompt (Probe): Median ${k(s.medianTaskPromptChars)}, müsste ${s.taskPromptWouldCap}× gekappt werden` : '',
        s.topReduced.length ? `Am häufigsten weggekappt: ${s.topReduced.map(item => `${item.heading.replace(/^## /, '')} (${item.count})`).join(', ')}` : '',
    ]
    return lines.filter(Boolean).join('\n')
}
