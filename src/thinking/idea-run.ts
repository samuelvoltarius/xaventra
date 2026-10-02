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
 *
 * 2.83.0:
 * - Jede Idee trägt ihr Ziel auch als Zahl (`measure`: Kennzahl, vorher, Ziel,
 *   Richtung) in `proposal.params`. Sagt der Owner Ja, vermerkt der
 *   Gedanken-Hub sie in `ideas-state.json` (`noteIdeaAccepted`).
 * - Nach 7 Tagen misst `runIdeaRun` dieselbe Kennzahl neu (`measureIdeaTarget`,
 *   dieselben Felder wie die Regeln), noch vor Nachtfenster und GPU-Grenze —
 *   das ist billig und braucht keine GPU. Ergebnis „erreicht“, „verfehlt“ oder
 *   „nicht messbar“ (zu wenig Aufrufe) als Gedanke und als Befund (Quelle
 *   `messung`) in den Entscheidungen. Verfehlt: dieselbe Idee darf nach
 *   `dedupeDays` wiederkommen, mit Hinweis.
 * - Hat der Owner diese Art dreimal abgelehnt (Faktor unter
 *   `THOUGHT_SUPPRESS_BELOW`), schlägt der Lauf sie nicht mehr vor.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { TraceInsights } from '../learning/trace-analyzer.js'
import { THOUGHT_SUPPRESS_BELOW } from '../core/decisions.js'
import {
    MAX_IDEAS_PER_DAY, judgeLoad, localDay, newThoughtId,
    type LoadProbe, type Thought, type ThoughtEvidence, type ThoughtSink, type ThinkingSettings,
} from './ports.js'

export interface IdeaBaseline { at: string; tools: Record<string, number> }
export interface CostSnapshot { todayCents: number; byProvider: Record<string, number> }
export interface IdeaInputs { insights: TraceInsights; baseline?: IdeaBaseline | null; costs?: CostSnapshot | null }

/** Das Ziel als Zahl: dieselbe Kennzahl wird nach 7 Tagen neu gemessen. */
export type IdeaDirection = 'unter' | 'ueber'
export interface IdeaMeasure { metrik: string; vorher: number; ziel: number; richtung: IdeaDirection; einheit?: string }

export interface IdeaCandidate {
    key: string
    rule: string
    subject: string
    title: string
    evidence: ThoughtEvidence[]
    target: string
    severity: number
    measure?: IdeaMeasure
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
                measure: { metrik: 'avgLatencyMs', vorher: tool.avgLatencyMs, ziel: round(tool.avgLatencyMs / 2), richtung: 'unter', einheit: 'ms' },
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
                measure: { metrik: 'avgLatencyMs', vorher: tool.avgLatencyMs, ziel: round(before * 1.2), richtung: 'unter', einheit: 'ms' },
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
                measure: { metrik: 'errorRate', vorher: round(tool.errorRate * 100, 1), ziel: round(tool.errorRate * 50, 1), richtung: 'unter', einheit: '%' },
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
                measure: { metrik: 'callCount', vorher: tool.callCount, ziel: round(tool.callCount * 0.7), richtung: 'unter' },
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
            measure: { metrik: 'avgSelfHealingRetries', vorher: retries, ziel: round(Math.min(t.retriesPerRequest, retries / 2), 2), richtung: 'unter' },
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
                measure: { metrik: 'successRate', vorher: round(model.successRate * 100, 1), ziel: round(Math.min(95, model.successRate * 100 + 10)), richtung: 'ueber', einheit: '%' },
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
            measure: { metrik: 'Tageskosten', vorher: round(costs.todayCents / 100, 2), ziel: round(t.costCentsPerDay / 200, 2), richtung: 'unter', einheit: 'USD' },
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

/** Eine vom Owner angenommene Idee, deren Ziel nach `IDEA_MEASURE_DAYS` nachgemessen wird. */
export interface AcceptedIdea extends IdeaMeasure {
    regel: string; subjekt: string; angenommenAm: string; faelligAm: string
    /** 2.86 Punkt 1: der Umsetzungsauftrag an Claude (Delegation `idee-ziel`). */
    delegationId?: string
    /** Wer die Umsetzung freigab: das Ja auf die Idee oder die Vertrauensleiter. */
    freigabe?: 'owner' | 'vertrauensleiter'
    /** Umsetzung läuft: gemessen wird erst, wenn Claude fertig meldet (die Uhr startet dann neu). */
    wartetAufUmsetzung?: boolean
    /** Claude meldete fertig; ab hier läuft die Nachmessung. */
    umgesetztAm?: string
    /** Die Umsetzung kam nicht zustande (abgelehnt, Fehler, Frist) — gemessen wird trotzdem, ohne Leiter. */
    umsetzungGescheitert?: string
}

/** 2.86 Punkt 1: Prüfart der Umsetzungs-Delegation und Art der Vertrauensleiter. */
export const IDEA_TARGET_CRITERION = 'idee-ziel'
export const IDEA_IMPLEMENTATION_KIND = 'idee-umsetzung'
/** Lesende Untersuchung einer Idee (ohne Agentic-OS-URL bzw. ohne messbares Ziel). */
export const IDEA_INVESTIGATION_CRITERION = 'idee-untersuchung'
/** Ohne Rückmeldung wird spätestens so lange nach dem Ja trotzdem gemessen. */
const IDEA_IMPLEMENTATION_MAX_WAIT_MS = 21 * 24 * 60 * 60_000

interface IdeaState {
    version: 1
    days: Record<string, number>
    proposed: Record<string, string>
    baseline?: IdeaBaseline
    /** 2.83.0: Schlüssel → angenommene Idee mit Zahlen und Fälligkeit. */
    angenommen?: Record<string, AcceptedIdea>
    /** 2.83.0: Schlüssel → Zeitpunkt der verfehlten Nachmessung (Hinweis beim nächsten Vorschlag). */
    verfehlt?: Record<string, string>
    /** 2.86 Punkt 1: letzte Nachmessung je Schlüssel (für die Prüfung der Umsetzungs-Delegation). */
    gemessen?: Record<string, { ergebnis: IdeaVerdict; at: string; delegationId?: string }>
}

export const IDEA_MEASURE_DAYS = 7
const MAX_ACCEPTED = 50
const KEY = /^[a-z][a-z0-9-]{1,40}:[^\s]{1,120}$/u

function loadState(path: string): IdeaState {
    try {
        if (existsSync(path)) {
            const value = JSON.parse(readFileSync(path, 'utf8'))
            return { version: 1, days: value.days || {}, proposed: value.proposed || {}, baseline: value.baseline, angenommen: value.angenommen || {}, verfehlt: value.verfehlt || {}, gemessen: value.gemessen || {} }
        }
    } catch { /* frisch */ }
    return { version: 1, days: {}, proposed: {}, angenommen: {}, verfehlt: {}, gemessen: {} }
}
function saveState(path: string, state: IdeaState): void {
    const days = Object.fromEntries(Object.entries(state.days).sort().slice(-30))
    const gemessen = Object.fromEntries(Object.entries(state.gemessen || {}).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-MAX_ACCEPTED))
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteJsonSync(path, { ...state, days, gemessen })
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

/**
 * Vom Gedanken-Hub beim „Ja“ auf eine Idee (2.83.0, Punkt 4): Zahlen und
 * Fälligkeit in `ideas-state.json` vermerken. Keine neue Datei.
 */
export function noteIdeaAccepted(input: { key: string; regel: string; subjekt: string } & IdeaMeasure, opts: { now?: Date; statePath?: string } = {}): AcceptedIdea | null {
    const key = String(input?.key || '')
    if (!KEY.test(key) || !finite(input.vorher) || !finite(input.ziel) || (input.richtung !== 'unter' && input.richtung !== 'ueber')) return null
    const now = opts.now || new Date()
    const path = opts.statePath || getNovaDataDir('thinking', 'ideas-state.json')
    const state = loadState(path)
    const entry: AcceptedIdea = {
        regel: String(input.regel).slice(0, 40), subjekt: String(input.subjekt).slice(0, 120), metrik: String(input.metrik).slice(0, 40),
        vorher: input.vorher, ziel: input.ziel, richtung: input.richtung, ...(input.einheit ? { einheit: String(input.einheit).slice(0, 10) } : {}),
        angenommenAm: now.toISOString(), faelligAm: new Date(now.getTime() + IDEA_MEASURE_DAYS * 24 * 60 * 60_000).toISOString(),
    }
    const accepted = { ...(state.angenommen || {}), [key]: entry }
    for (const old of Object.keys(accepted).sort((a, b) => accepted[a].angenommenAm.localeCompare(accepted[b].angenommenAm)).slice(0, Math.max(0, Object.keys(accepted).length - MAX_ACCEPTED))) delete accepted[old]
    saveState(path, { ...state, angenommen: accepted })
    return entry
}

/** Lesend: angenommene Ideen, deren Ziel noch nachgemessen wird (/gedanken, Tests). */
export function listAcceptedIdeas(opts: { statePath?: string } = {}): Record<string, AcceptedIdea> {
    return { ...(loadState(opts.statePath || getNovaDataDir('thinking', 'ideas-state.json')).angenommen || {}) }
}

const ideasPath = (statePath?: string) => statePath || getNovaDataDir('thinking', 'ideas-state.json')

function updateAccepted(key: string, statePath: string | undefined, change: (entry: AcceptedIdea) => AcceptedIdea | null): AcceptedIdea | null {
    const path = ideasPath(statePath)
    const state = loadState(path)
    const entry = state.angenommen?.[key]
    if (!entry) return null
    const next = change({ ...entry })
    if (!next) return null
    saveState(path, { ...state, angenommen: { ...(state.angenommen || {}), [key]: next } })
    return next
}

/**
 * 2.86 Punkt 1: das Ja hat einen Umsetzungsauftrag an Claude ausgelöst. Bis
 * Claude fertig meldet, wird nicht nachgemessen (sonst misst die Nachmessung
 * einen unveränderten Zustand).
 */
export function noteIdeaDelegated(key: string, input: { delegationId: string; freigabe: 'owner' | 'vertrauensleiter' }, opts: { statePath?: string } = {}): AcceptedIdea | null {
    if (!/^dlg-[a-f0-9]{12}$/.test(String(input?.delegationId))) return null
    return updateAccepted(key, opts.statePath, entry => ({
        ...entry, delegationId: input.delegationId, freigabe: input.freigabe === 'vertrauensleiter' ? 'vertrauensleiter' : 'owner', wartetAufUmsetzung: true,
    }))
}

/**
 * 2.86 Punkt 1: die Umsetzungs-Delegation ist abgeschlossen. Fertig: die Uhr
 * der Nachmessung startet jetzt (bei schon gemessen erreichtem Ziel sofort
 * fällig). Sonst wird gemessen wie ohne Umsetzung; die Leiter stuft zurück.
 */
export function noteIdeaImplementation(key: string, outcome: { delegationId: string; status: string; verified: boolean }, opts: { statePath?: string; now?: Date } = {}): AcceptedIdea | null {
    const now = opts.now || new Date()
    return updateAccepted(key, opts.statePath, entry => {
        if (entry.delegationId !== outcome.delegationId) return null
        if (outcome.status === 'fertig') {
            const due = outcome.verified ? now : new Date(now.getTime() + IDEA_MEASURE_DAYS * 24 * 60 * 60_000)
            return { ...entry, wartetAufUmsetzung: false, umgesetztAm: now.toISOString(), faelligAm: due.toISOString() }
        }
        return { ...entry, wartetAufUmsetzung: false, umsetzungGescheitert: String(outcome.status).slice(0, 40) }
    })
}

/**
 * 2.86 Punkt 1: lesende Prüfung für `erwartet.art = 'idee-ziel'` (Text =
 * Ideen-Schlüssel). Verifiziert nur, wenn dieselbe Kennzahl das Ziel jetzt
 * erreicht oder die Nachmessung es schon ergab. Claudes Wort zählt nicht.
 */
export function ideaTargetVerifier(opts: { inputs: () => Promise<IdeaInputs> | IdeaInputs; statePath?: string }) {
    return async (expectation: { text?: string }): Promise<{ ergebnis: 'verifiziert' | 'nicht-erfuellt' | 'unverifiziert'; detail: string }> => {
        const key = String(expectation?.text || '').trim()
        if (!KEY.test(key)) return { ergebnis: 'unverifiziert', detail: 'kein Ideen-Schlüssel im Kriterium' }
        const state = loadState(ideasPath(opts.statePath))
        const entry = state.angenommen?.[key]
        const gemessen = state.gemessen?.[key]
        if (!entry) {
            if (gemessen?.ergebnis === 'erreicht') return { ergebnis: 'verifiziert', detail: `Nachmessung ${gemessen.at.slice(0, 10)}: Ziel erreicht` }
            if (gemessen?.ergebnis === 'verfehlt') return { ergebnis: 'nicht-erfuellt', detail: `Nachmessung ${gemessen.at.slice(0, 10)}: Ziel verfehlt` }
            return { ergebnis: 'unverifiziert', detail: 'Idee nicht (mehr) vermerkt' }
        }
        let measured: IdeaMeasurement
        try { measured = measureIdeaTarget(entry.regel, entry.subjekt, await opts.inputs()) } catch { measured = { value: null, reason: 'Messung nicht möglich' } }
        const unit = entry.einheit ? ` ${entry.einheit}` : ''
        const goal = `Ziel ${entry.richtung === 'ueber' ? 'über' : 'unter'} ${entry.ziel}${unit}`
        if (judgeIdeaTarget(entry, measured) === 'erreicht') return { ergebnis: 'verifiziert', detail: `${entry.metrik} jetzt ${measured.value}${unit}, ${goal}` }
        const now = measured.value === null ? `nicht messbar (${measured.reason || 'zu wenig Daten'})` : `jetzt ${measured.value}${unit}`
        return { ergebnis: 'unverifiziert', detail: `wartet auf Messung: ${entry.metrik} ${now}, ${goal}; Nachmessung ${IDEA_MEASURE_DAYS} Tage nach der Umsetzung` }
    }
}

let wiring: { inputs: () => Promise<IdeaInputs> | IdeaInputs; statePath?: string } | null = null
let listenerAttached = false

/**
 * 2.86 Punkt 1: Prüfer `idee-ziel` und der eine Listener auf das Ende der
 * Umsetzungs-Delegation. Idempotent; die zuletzt übergebenen Eingaben gelten.
 */
export async function wireIdeaImplementation(opts: { inputs: () => Promise<IdeaInputs> | IdeaInputs; statePath?: string }): Promise<void> {
    wiring = opts
    const { onDelegationSettled, registerDelegationVerifier } = await import('../core/delegation.js')
    const verifier = ideaTargetVerifier({ inputs: () => (wiring || opts).inputs(), statePath: opts.statePath })
    registerDelegationVerifier(IDEA_TARGET_CRITERION, expectation => verifier(expectation), { offen: 'messung' })
    // Without an Agentic-OS URL only a read-only investigation is possible: its result is
    // data for the report (an idea line), not an unverified warning.
    registerDelegationVerifier(IDEA_INVESTIGATION_CRITERION, async () => ({ ergebnis: 'unverifiziert', detail: 'Untersuchung, keine Umsetzung — Ergebnis als Idee im Bericht' }), { offen: 'bericht' })
    if (listenerAttached) return
    listenerAttached = true
    onDelegationSettled(async (record, info) => {
        if (record.erwartet?.art !== IDEA_TARGET_CRITERION) return
        const entry = noteIdeaImplementation(String(record.erwartet.text || ''), { delegationId: record.id, status: record.status, verified: info.verified }, { statePath: wiring?.statePath })
        if (!entry || record.status === 'fertig') return
        // Claude lehnte ab, Fehler oder Frist: die Umsetzung kam nicht zustande → Leiter zurück.
        try {
            const { recordActionOutcome } = await import('../core/action-policy.js')
            recordActionOutcome(IDEA_IMPLEMENTATION_KIND, { ok: false, approvedByOwner: entry.freigabe !== 'vertrauensleiter' })
        } catch { /* Leiter ist Buchhaltung, nie Grund zum Scheitern */ }
    })
}

export interface IdeaMeasurement { value: number | null; reason?: string }

/** Rein: dieselbe Kennzahl wie die Regel, aus denselben Feldern. Zu wenig Daten → `value: null`. */
export function measureIdeaTarget(rule: string, subject: string, inputs: IdeaInputs): IdeaMeasurement {
    const t = IDEA_THRESHOLDS
    if (rule === 'kosten') {
        const costs = inputs?.costs
        return costs && finite(costs.todayCents) ? { value: round(costs.todayCents / 100, 2) } : { value: null, reason: 'keine Kostendaten' }
    }
    const insights = inputs?.insights
    if (!insights || !(insights.tracesAnalyzed > 0)) return { value: null, reason: 'keine Traces' }
    if (rule === 'selbstheilung-wiederholungen') {
        return insights.tracesAnalyzed >= t.minTracesForRetries
            ? { value: insights.overall?.avgSelfHealingRetries ?? 0 }
            : { value: null, reason: `nur ${insights.tracesAnalyzed} Läufe (mindestens ${t.minTracesForRetries})` }
    }
    if (rule === 'modell-erfolg') {
        const model = (insights.models || []).find(item => item.modelId === subject)
        return model && model.callCount >= t.modelMinCalls
            ? { value: round(model.successRate * 100, 1) }
            : { value: null, reason: `${subject}: ${model?.callCount ?? 0} Aufrufe (mindestens ${t.modelMinCalls})` }
    }
    const tool = (insights.tools || []).find(item => item.name === subject)
    if (!tool || !(tool.callCount >= t.minCalls)) return { value: null, reason: `${subject}: ${tool?.callCount ?? 0} Aufrufe (mindestens ${t.minCalls})` }
    if (rule === 'werkzeug-langsam' || rule === 'werkzeug-langsamer') return { value: tool.avgLatencyMs }
    if (rule === 'werkzeug-fehler') return { value: round(tool.errorRate * 100, 1) }
    if (rule === 'werkzeug-cache') return { value: tool.callCount }
    return { value: null, reason: `unbekannte Regel ${rule}` }
}

export type IdeaVerdict = 'erreicht' | 'verfehlt' | 'nicht-messbar'

/** Rein: Zahl gegen Ziel. Kein Modell entscheidet. */
export function judgeIdeaTarget(entry: Pick<IdeaMeasure, 'richtung' | 'ziel'>, measured: IdeaMeasurement): IdeaVerdict {
    if (measured.value === null || !finite(measured.value)) return 'nicht-messbar'
    return (entry.richtung === 'ueber' ? measured.value > entry.ziel : measured.value < entry.ziel) ? 'erreicht' : 'verfehlt'
}

export interface IdeaMeasurementResult {
    key: string; regel: string; subjekt: string; metrik: string; ergebnis: IdeaVerdict; richtung: IdeaDirection
    vorher: number; ziel: number; jetzt: number | null; einheit?: string; grund?: string
    /** 2.86 Punkt 1: die Umsetzungs-Delegation, falls Claude umgesetzt hat. */
    delegationId?: string
}

async function defaultRecordTrust(outcome: { ok: boolean; approvedByOwner: boolean }): Promise<void> {
    const { recordActionOutcome } = await import('../core/action-policy.js')
    recordActionOutcome(IDEA_IMPLEMENTATION_KIND, outcome)
}

async function defaultRecordMeasurement(result: IdeaMeasurementResult): Promise<void> {
    const { recordMeasurementDecision } = await import('../core/decisions.js')
    recordMeasurementDecision(result)
}

function withoutMeasure(candidate: IdeaCandidate): IdeaCandidate {
    const { measure: _measure, ...rest } = candidate
    return rest
}

function measureParams(measure?: IdeaMeasure): Record<string, string | number> {
    if (!measure) return {}
    return { metrik: measure.metrik, vorher: measure.vorher, ziel: measure.ziel, richtung: measure.richtung, ...(measure.einheit ? { einheit: measure.einheit } : {}) }
}

const VERDICT_LABEL: Record<IdeaVerdict, string> = { erreicht: 'Ziel erreicht', verfehlt: 'Ziel verfehlt', 'nicht-messbar': 'nicht messbar' }

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
    /** Befund der Nachmessung (Standard: decisions.ts, Quelle `messung`). */
    recordMeasurement?: (result: IdeaMeasurementResult) => void | Promise<void>
    /**
     * 2.86 Punkt 2 (Paket F): Fähigkeiten, die der Software-Scout als fehlend führt
     * (Standard: `readScoutMissingCapabilities`). Ein scheiterndes Werkzeug dieser
     * Fähigkeit ist kein `werkzeug-fehler`, sondern ein Bedarf beim Scout.
     */
    missingCapabilities?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>
    /** 2.86 Punkt 1: Ergebnis einer umgesetzten Idee für die Vertrauensleiter (Standard: action-policy.ts). */
    recordTrust?: (outcome: { ok: boolean; approvedByOwner: boolean }) => void | Promise<void>
    now?: Date
    statePath?: string
}

/** Fällige angenommene Ideen nachmessen (vor Nachtfenster und GPU-Grenze: billig, keine GPU). */
async function measureDueIdeas(deps: IdeaRunDeps, statePath: string, now: Date): Promise<{ results: IdeaMeasurementResult[]; inputs?: IdeaInputs }> {
    // 2.86 Punkt 1: eine laufende Umsetzung wird erst nach Claudes „fertig“ gemessen (höchstens 21 Tage gewartet).
    const waiting = (entry: AcceptedIdea) => entry.wartetAufUmsetzung === true && now.getTime() - Date.parse(entry.angenommenAm) < IDEA_IMPLEMENTATION_MAX_WAIT_MS
    const due = Object.entries(loadState(statePath).angenommen || {}).filter(([, entry]) => Date.parse(entry.faelligAm) <= now.getTime() && !waiting(entry))
    if (!due.length) return { results: [] }
    const inputs = await deps.inputs()
    const state = loadState(statePath)
    const results: IdeaMeasurementResult[] = []
    const ladder: Array<{ ok: boolean; approvedByOwner: boolean }> = []
    for (const [key] of due) {
        const entry = state.angenommen?.[key]
        if (!entry) continue
        const measured = measureIdeaTarget(entry.regel, entry.subjekt, inputs)
        const ergebnis = judgeIdeaTarget(entry, measured)
        results.push({
            key, regel: entry.regel, subjekt: entry.subjekt, metrik: entry.metrik, ergebnis, richtung: entry.richtung, vorher: entry.vorher, ziel: entry.ziel,
            jetzt: measured.value, ...(entry.einheit ? { einheit: entry.einheit } : {}), ...(measured.reason ? { grund: measured.reason } : {}),
            ...(entry.delegationId ? { delegationId: entry.delegationId } : {}),
        })
        delete state.angenommen![key]
        state.gemessen = { ...(state.gemessen || {}), [key]: { ergebnis, at: now.toISOString(), ...(entry.delegationId ? { delegationId: entry.delegationId } : {}) } }
        if (ergebnis === 'verfehlt') state.verfehlt = { ...(state.verfehlt || {}), [key]: now.toISOString() }
        // 2.86 Punkt 1: nur eine tatsächlich umgesetzte Idee zählt für die Vertrauensleiter;
        // „nicht messbar“ zählt weder hoch noch runter.
        if (entry.delegationId && entry.umgesetztAm && !entry.umsetzungGescheitert && ergebnis !== 'nicht-messbar') {
            ladder.push({ ok: ergebnis === 'erreicht', approvedByOwner: entry.freigabe !== 'vertrauensleiter' })
        }
    }
    saveState(statePath, state)
    for (const outcome of ladder) {
        try { await (deps.recordTrust || defaultRecordTrust)(outcome) } catch { /* Leiter ist Buchhaltung */ }
    }
    for (const result of results) {
        const unit = result.einheit ? ` ${result.einheit}` : ''
        const jetzt = result.jetzt === null ? `nicht messbar (${result.grund || 'zu wenig Daten'})` : `${result.jetzt}${unit}`
        const thought: Thought = {
            id: newThoughtId('ideen-lauf', now), createdAt: now.toISOString(), source: 'ideen-lauf', kind: `messung:${result.regel}`,
            title: `Idee ${result.regel} ${result.subjekt}: ${VERDICT_LABEL[result.ergebnis]}${result.jetzt === null ? '' : ` (vorher ${result.vorher}${unit}, jetzt ${result.jetzt}${unit})`}`,
            text: [`Nachmessung nach ${IDEA_MEASURE_DAYS} Tagen: ${result.metrik} vorher ${result.vorher}${unit}, Ziel ${result.richtung === 'ueber' ? 'über' : 'unter'} ${result.ziel}${unit}, jetzt ${jetzt}.`,
                result.ergebnis === 'verfehlt' ? `Die Idee darf nach ${deps.settings.ideas.dedupeDays} Tagen wiederkommen (Hinweis: letzter Versuch verfehlt).` : ''].filter(Boolean).join('\n'),
            evidence: [
                { metric: `${result.metrik} vorher`, value: result.vorher, ...(result.einheit ? { unit: result.einheit } : {}), source: 'Ideen-Lauf bei Annahme' },
                ...(result.jetzt === null ? [] : [{ metric: `${result.metrik} jetzt`, value: result.jetzt, ...(result.einheit ? { unit: result.einheit } : {}), source: `traces ${IDEA_MEASURE_DAYS} Tage` }]),
            ],
            importance: 0.3, stufe: 'selbst', status: 'info', dedupeKey: `messung:${result.key}:${now.toISOString().slice(0, 10)}`,
        }
        try { await deps.sink.emit(thought) } catch { /* Gedanke optional */ }
        try { await (deps.recordMeasurement || defaultRecordMeasurement)(result) } catch { /* Befund optional */ }
    }
    return { results, inputs }
}

async function scoutCapabilityGap(deps: IdeaRunDeps): Promise<(tool: string) => boolean> {
    try {
        const demand = await import('../install/software-demand.js')
        const missing = deps.missingCapabilities ? await deps.missingCapabilities() : demand.readScoutMissingCapabilities()
        if (!missing.size) return () => false
        return tool => { const capability = demand.capabilityForTool(tool); return Boolean(capability && missing.has(capability)) }
    } catch { return () => false }
}

export async function runIdeaRun(deps: IdeaRunDeps): Promise<{ ran: boolean; reason: string; ideas: Thought[]; measured?: IdeaMeasurementResult[] }> {
    const now = deps.now || new Date()
    const cfg = deps.settings.ideas
    if (!deps.settings.enabled || !cfg.enabled) return { ran: false, reason: 'aus', ideas: [] }
    const statePath = deps.statePath || getNovaDataDir('thinking', 'ideas-state.json')
    const { results: measured, inputs: measuredInputs } = await measureDueIdeas(deps, statePath, now)
    const extra = measured.length ? { measured } : {}
    if (!inNightWindow(now, cfg.nightStartHour, cfg.nightEndHour)) return { ran: false, reason: `außerhalb Nachtfenster ${cfg.nightStartHour}–${cfg.nightEndHour} Uhr`, ideas: [], ...extra }
    const state = loadState(statePath)
    const day = localDay(now)
    const limit = Math.min(MAX_IDEAS_PER_DAY, cfg.maxPerDay)
    const remaining = limit - (state.days[day] || 0)
    if (remaining <= 0) return { ran: false, reason: `Tagesgrenze erreicht (${limit} Ideen)`, ideas: [], ...extra }

    const load = judgeLoad(await deps.load.sample(), deps.settings.load)
    if (!load.idle) return { ran: false, reason: load.reason, ideas: [], ...extra }

    const inputs = measuredInputs || await deps.inputs()
    const withBaseline: IdeaInputs = { ...inputs, baseline: inputs.baseline ?? state.baseline ?? null }
    const dedupeMs = cfg.dedupeDays * 24 * 60 * 60_000
    // Owner hat diese Art dreimal abgelehnt (ohne Ja dazwischen): nicht mehr vorschlagen (2.83.0, Punkt 10).
    const suppressed = (item: IdeaCandidate) => deps.importanceFactor ? deps.importanceFactor(`idee:${item.rule}`) < THOUGHT_SUPPRESS_BELOW : false
    // Ein Bedarf, ein Empfänger: fehlt die Fähigkeit (Scout-Befund), geht der Fehler an den Scout.
    const capabilityGap = await scoutCapabilityGap(deps)
    const candidates = (deps.rules || findIdeaCandidates)(withBaseline)
        .filter(hasEvidence)
        .filter(item => !(item.rule === 'werkzeug-fehler' && capabilityGap(item.subject)))
        .filter(item => !state.angenommen?.[item.key])
        .filter(item => !suppressed(item))
        .filter(item => { const last = state.proposed[item.key]; return !last || now.getTime() - Date.parse(last) >= dedupeMs })
        .slice(0, remaining)

    const ideas: Thought[] = []
    for (const candidate of candidates) {
        let worded = ''
        if (deps.formulate) {
            try {
                worded = String(await Promise.race([
                    // Das Modell bekommt dieselben Felder wie bisher; das Ziel als Zahl bleibt beim Code.
                    deps.formulate(structuredClone(withoutMeasure(candidate))),
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
            text: [worded || `${candidate.title}.`, `Beleg: ${evidenceLine(candidate.evidence)}`, `Ziel: ${candidate.target}`,
                state.verfehlt?.[candidate.key] ? `Hinweis: letzter Versuch verfehlt (Nachmessung ${state.verfehlt[candidate.key].slice(0, 10)}).` : ''].filter(Boolean).join('\n'),
            evidence: structuredClone(candidate.evidence), target: candidate.target,
            importance: Math.min(1, 0.3 + 0.2 * candidate.severity) * factor,
            // Alles, was der Gedanken-Hub beim „Ja“ braucht: Regel, Subjekt und das Ziel als Zahl.
            proposal: { action: 'idee-pruefen', params: { regel: candidate.rule, subjekt: candidate.subject, ...measureParams(candidate.measure) }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: candidate.key,
        }
        await deps.sink.emit(thought)
        ideas.push(thought)
        state.proposed[candidate.key] = now.toISOString()
        state.days[day] = (state.days[day] || 0) + 1
        if (state.verfehlt?.[candidate.key]) delete state.verfehlt[candidate.key]
    }
    const baselineAgeMs = state.baseline ? now.getTime() - Date.parse(state.baseline.at) : Infinity
    if (!(baselineAgeMs < 7 * 24 * 60 * 60_000) && inputs.insights?.tools?.length) {
        state.baseline = { at: day, tools: Object.fromEntries(inputs.insights.tools.filter(tool => tool.callCount >= IDEA_THRESHOLDS.minCalls).map(tool => [tool.name, tool.avgLatencyMs])) }
    }
    // Ein „Ja“ während des Laufs (Gedanken-Hub) bleibt erhalten: angenommen frisch von der Platte.
    saveState(statePath, { ...state, angenommen: loadState(statePath).angenommen })
    return { ran: true, reason: ideas.length ? `${ideas.length} Idee(n)` : 'keine belegte Idee', ideas, ...extra }
}
