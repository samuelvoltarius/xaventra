/**
 * Phase 3 — Ideen-Lauf („was könnten wir besser/schneller machen?").
 *
 * Nachts, höchstens einmal pro Tag (Schedule-Port) und nur, wenn die GPU bzw.
 * vLLM gemessen ruhig ist (LoadProbe-Port, nicht messbar = belegt).
 *
 * Feste Regeln finden die Kandidaten aus Traces (`analyzeTraces`, dieselben
 * Zahlen wie `nova_trace_stats`), Werkzeug-Latenzen, Fehlerraten und Kosten
 * (L14). Jede Idee hat Belege (Zahl vorher + Quelle) und ein messbares Ziel.
 * Das Modell (optionaler `Formulator`) formuliert nur den Text; Belege, Ziel,
 * Auswahl und Erlaubnisstufe setzt der Code. Höchstens 3 Ideen pro Tag
 * (`MAX_IDEAS_PER_DAY`, per Config nur senkbar). Ausgang nur über den
 * ThoughtSink, Stufe `fragen` — umgesetzt wird nichts.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { TraceInsights } from '../learning/trace-analyzer.js'
import {
    MAX_IDEAS_PER_DAY, judgeLoad, localDay, newThoughtId,
    type LoadProbe, type Thought, type ThoughtEvidence, type ThoughtSink, type ThinkingSettings,
} from './ports.js'

export interface IdeaBaseline { at: string; tools: Record<string, number> }
export interface CostSnapshot { todayCents: number; byProvider: Record<string, number> }
export interface IdeaInputs { insights: TraceInsights; baseline?: IdeaBaseline | null; costs?: CostSnapshot | null }

export interface IdeaCandidate {
    key: string
    rule: string
    subject: string
    title: string
    evidence: ThoughtEvidence[]
    target: string
    severity: number
}

export type Formulator = (candidate: IdeaCandidate) => Promise<string>

export const IDEA_THRESHOLDS = Object.freeze({
    minCalls: 5,
    slowAvgMs: 5_000,
    slowerFactor: 2,
    failingRate: 0.2,
    cacheRepeats: 3,
    retriesPerRequest: 0.3,
    minTracesForRetries: 20,
    modelMinCalls: 20,
    modelSuccessRate: 0.8,
    costCentsPerDay: 200,
})

const round = (value: number, digits = 0) => { const factor = 10 ** digits; return Math.round(value * factor) / factor }

/** Reine Regeln: was ist auffällig? Ohne Zahlen keine Idee. */
export function findIdeaCandidates(inputs: IdeaInputs): IdeaCandidate[] {
    const t = IDEA_THRESHOLDS
    const { insights } = inputs
    const out: IdeaCandidate[] = []
    if (!insights || !(insights.tracesAnalyzed > 0)) return out
    const window = `traces ${insights.periodDays} Tage, ${insights.tracesAnalyzed} Läufe`

    for (const tool of insights.tools || []) {
        if (!(tool.callCount >= t.minCalls)) continue
        if (tool.avgLatencyMs >= t.slowAvgMs) {
            out.push({
                key: `werkzeug-langsam:${tool.name}`, rule: 'werkzeug-langsam', subject: tool.name,
                title: `Werkzeug ${tool.name} ist langsam`,
                evidence: [
                    { metric: 'avgLatencyMs', value: tool.avgLatencyMs, unit: 'ms', source: window },
                    { metric: 'p95LatencyMs', value: tool.p95LatencyMs, unit: 'ms', source: window },
                    { metric: 'callCount', value: tool.callCount, source: window },
                ],
                target: `Ø-Latenz von ${tool.name} unter ${round(tool.avgLatencyMs / 2)} ms in den nächsten 7 Tagen`,
                severity: tool.avgLatencyMs / t.slowAvgMs,
            })
        }
        const before = inputs.baseline?.tools?.[tool.name]
        if (typeof before === 'number' && before > 0 && tool.avgLatencyMs >= before * t.slowerFactor) {
            out.push({
                key: `werkzeug-langsamer:${tool.name}`, rule: 'werkzeug-langsamer', subject: tool.name,
                title: `Werkzeug ${tool.name} ist ${round(tool.avgLatencyMs / before, 1)}× langsamer als am ${inputs.baseline!.at}`,
                evidence: [
                    { metric: 'avgLatencyMs vorher', value: before, unit: 'ms', source: `Ideen-Lauf-Basis ${inputs.baseline!.at}` },
                    { metric: 'avgLatencyMs jetzt', value: tool.avgLatencyMs, unit: 'ms', source: window },
                ],
                target: `Ø-Latenz von ${tool.name} wieder unter ${round(before * 1.2)} ms`,
                severity: tool.avgLatencyMs / before / t.slowerFactor,
            })
        }
        if (tool.errorRate >= t.failingRate) {
            out.push({
                key: `werkzeug-fehler:${tool.name}`, rule: 'werkzeug-fehler', subject: tool.name,
                title: `Werkzeug ${tool.name} scheitert oft`,
                evidence: [
                    { metric: 'errorRate', value: round(tool.errorRate * 100, 1), unit: '%', source: window },
                    { metric: 'callCount', value: tool.callCount, source: window },
                ],
                target: `Fehlerrate von ${tool.name} unter ${round(tool.errorRate * 50, 1)} % in den nächsten 7 Tagen`,
                severity: tool.errorRate / t.failingRate,
            })
        }
        if (tool.cacheCandidates >= t.cacheRepeats) {
            out.push({
                key: `werkzeug-cache:${tool.name}`, rule: 'werkzeug-cache', subject: tool.name,
                title: `Werkzeug ${tool.name} wird oft mit gleichen Argumenten aufgerufen`,
                evidence: [
                    { metric: 'gleiche Argumente ≥3×', value: tool.cacheCandidates, source: window },
                    { metric: 'callCount', value: tool.callCount, source: window },
                ],
                target: `mindestens 30 % weniger echte Aufrufe von ${tool.name} (unter ${round(tool.callCount * 0.7)} in 7 Tagen)`,
                severity: tool.cacheCandidates / t.cacheRepeats,
            })
        }
    }

    const retries = insights.overall?.avgSelfHealingRetries ?? 0
    if (insights.tracesAnalyzed >= t.minTracesForRetries && retries > t.retriesPerRequest) {
        out.push({
            key: 'selbstheilung-wiederholungen:gesamt', rule: 'selbstheilung-wiederholungen', subject: 'gesamt',
            title: 'Viele Werkzeug-Wiederholungen pro Anfrage',
            evidence: [{ metric: 'Self-Healing-Retries pro Anfrage', value: retries, source: window }],
            target: `unter ${round(Math.min(t.retriesPerRequest, retries / 2), 2)} Wiederholungen pro Anfrage`,
            severity: retries / t.retriesPerRequest,
        })
    }

    for (const model of insights.models || []) {
        if (model.callCount >= t.modelMinCalls && model.successRate < t.modelSuccessRate) {
            out.push({
                key: `modell-erfolg:${model.modelId}`, rule: 'modell-erfolg', subject: model.modelId,
                title: `Modell ${model.modelId} hat eine niedrige Erfolgsrate`,
                evidence: [
                    { metric: 'successRate', value: round(model.successRate * 100, 1), unit: '%', source: window },
                    { metric: 'callCount', value: model.callCount, source: window },
                ],
                target: `Erfolgsrate von ${model.modelId} über ${round(Math.min(95, model.successRate * 100 + 10))} %`,
                severity: (t.modelSuccessRate - model.successRate) / 0.1,
            })
        }
    }

    const costs = inputs.costs
    if (costs && costs.todayCents >= t.costCentsPerDay) {
        const [provider, cents] = Object.entries(costs.byProvider || {}).sort((a, b) => b[1] - a[1])[0] || ['?', 0]
        out.push({
            key: `kosten:${provider}`, rule: 'kosten', subject: provider,
            title: `Hohe Tageskosten, vor allem ${provider}`,
            evidence: [
                { metric: 'Kosten heute', value: round(costs.todayCents / 100, 2), unit: 'USD', source: 'L14 Cost-Tracker' },
                { metric: `Anteil ${provider}`, value: costs.todayCents > 0 ? round(cents / costs.todayCents * 100) : 0, unit: '%', source: 'L14 Cost-Tracker' },
            ],
            target: `Tageskosten unter ${round(t.costCentsPerDay / 200, 2)} USD`,
            severity: costs.todayCents / t.costCentsPerDay,
        })
    }
    return out.sort((a, b) => b.severity - a.severity)
}

/** Belegt heißt: mindestens eine Zahl mit Quelle, und das Ziel enthält eine Zahl. */
export function hasEvidence(candidate: IdeaCandidate): boolean {
    return candidate.evidence.length > 0
        && candidate.evidence.every(item => typeof item.value === 'number' && Number.isFinite(item.value) && /\S/.test(item.source))
        && /\d/.test(candidate.target || '')
}

interface IdeaState { version: 1; days: Record<string, number>; proposed: Record<string, string>; baseline?: IdeaBaseline }

function loadState(path: string): IdeaState {
    try { if (existsSync(path)) { const value = JSON.parse(readFileSync(path, 'utf8')); return { version: 1, days: value.days || {}, proposed: value.proposed || {}, baseline: value.baseline } } } catch { /* frisch */ }
    return { version: 1, days: {}, proposed: {} }
}
function saveState(path: string, state: IdeaState): void {
    const days = Object.fromEntries(Object.entries(state.days).sort().slice(-30))
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteJsonSync(path, { ...state, days })
}

export function inNightWindow(now: Date, startHour: number, endHour: number): boolean {
    const hour = now.getHours()
    return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour
}

function evidenceLine(evidence: ThoughtEvidence[]): string {
    return evidence.map(item => `${item.metric} = ${item.value}${item.unit ? ` ${item.unit}` : ''} (${item.source})`).join('; ')
}

export interface IdeaRunDeps {
    settings: ThinkingSettings
    load: LoadProbe
    sink: ThoughtSink
    inputs: () => Promise<IdeaInputs> | IdeaInputs
    formulate?: Formulator
    /** Regeln austauschbar (Tests, später weitere Quellen); Belegpflicht gilt trotzdem. */
    rules?: (inputs: IdeaInputs) => IdeaCandidate[]
    importanceFactor?: (kind: string) => number
    now?: Date
    statePath?: string
}

export async function runIdeaRun(deps: IdeaRunDeps): Promise<{ ran: boolean; reason: string; ideas: Thought[] }> {
    const now = deps.now || new Date()
    const cfg = deps.settings.ideas
    if (!deps.settings.enabled || !cfg.enabled) return { ran: false, reason: 'aus', ideas: [] }
    if (!inNightWindow(now, cfg.nightStartHour, cfg.nightEndHour)) return { ran: false, reason: `außerhalb Nachtfenster ${cfg.nightStartHour}–${cfg.nightEndHour} Uhr`, ideas: [] }
    const statePath = deps.statePath || getNovaDataDir('thinking', 'ideas-state.json')
    const state = loadState(statePath)
    const day = localDay(now)
    const limit = Math.min(MAX_IDEAS_PER_DAY, cfg.maxPerDay)
    const remaining = limit - (state.days[day] || 0)
    if (remaining <= 0) return { ran: false, reason: `Tagesgrenze erreicht (${limit} Ideen)`, ideas: [] }

    const load = judgeLoad(await deps.load.sample(), deps.settings.load)
    if (!load.idle) return { ran: false, reason: load.reason, ideas: [] }

    const inputs = await deps.inputs()
    const withBaseline: IdeaInputs = { ...inputs, baseline: inputs.baseline ?? state.baseline ?? null }
    const dedupeMs = cfg.dedupeDays * 24 * 60 * 60_000
    const candidates = (deps.rules || findIdeaCandidates)(withBaseline)
        .filter(hasEvidence)
        .filter(item => { const last = state.proposed[item.key]; return !last || now.getTime() - Date.parse(last) >= dedupeMs })
        .slice(0, remaining)

    const ideas: Thought[] = []
    for (const candidate of candidates) {
        let worded = ''
        if (deps.formulate) {
            try {
                worded = String(await Promise.race([
                    deps.formulate(structuredClone(candidate)),
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000).unref?.()),
                ]) || '').trim().slice(0, 600)
            } catch { worded = '' }
        }
        const kind = `idee:${candidate.rule}`
        const factor = deps.importanceFactor ? deps.importanceFactor(kind) : 1
        const thought: Thought = {
            id: newThoughtId('ideen-lauf', now), createdAt: now.toISOString(), source: 'ideen-lauf', kind,
            title: candidate.title,
            // Belege und Ziel hängt der Code an — der Modelltext kann sie nicht ersetzen.
            text: [worded || `${candidate.title}.`, `Beleg: ${evidenceLine(candidate.evidence)}`, `Ziel: ${candidate.target}`].join('\n'),
            evidence: structuredClone(candidate.evidence), target: candidate.target,
            importance: Math.min(1, 0.3 + 0.2 * candidate.severity) * factor,
            proposal: { action: 'idee-pruefen', params: { regel: candidate.rule, subjekt: candidate.subject }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: candidate.key,
        }
        await deps.sink.emit(thought)
        ideas.push(thought)
        state.proposed[candidate.key] = now.toISOString()
        state.days[day] = (state.days[day] || 0) + 1
    }
    const baselineAgeMs = state.baseline ? now.getTime() - Date.parse(state.baseline.at) : Infinity
    if (!(baselineAgeMs < 7 * 24 * 60 * 60_000) && inputs.insights?.tools?.length) {
        state.baseline = { at: day, tools: Object.fromEntries(inputs.insights.tools.filter(tool => tool.callCount >= IDEA_THRESHOLDS.minCalls).map(tool => [tool.name, tool.avgLatencyMs])) }
    }
    saveState(statePath, state)
    return { ran: true, reason: ideas.length ? `${ideas.length} Idee(n)` : 'keine belegte Idee', ideas }
}
