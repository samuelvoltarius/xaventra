import type { ActionIntent } from '../core/action-intent.js'
import { isConversationalClosure } from '../core/action-intent.js'
import { hasProvenCapability, measurementFor, requiredCapability, type EndpointKind, type ModelRegistry, type PrivacyClass } from './model-registry.js'

/**
 * CL-20260930-12 — model choice per task instead of one global switch.
 *
 * A fixed rule table decides between Codex (owner's subscription) and the
 * local vLLM model. The model never chooses its own route, and no input can
 * loosen the hard limits:
 *   - pictures, screenshots and private content (memory, customer data) stay
 *     on the Spark; private text leaves it only with an explicit owner yes
 *   - Codex only for the owner (L7)
 *   - codex.enabled=false keeps everything local ("wäre Codex, aber aus")
 *   - outage or exhausted quota falls back to local, with a notice
 */

export type TaskModelClass = 'code' | 'refactor' | 'debug' | 'vision' | 'smalltalk' | 'short' | 'general'
export type TaskModelTarget = 'codex' | 'local'

export const CODEX_TASK_CLASSES: readonly TaskModelClass[] = ['code', 'refactor', 'debug']

export const TASK_CLASS_LABELS: Record<TaskModelClass, string> = {
    code: 'Code',
    refactor: 'größere Umbauten',
    debug: 'schwierige Fehlersuche',
    vision: 'Bilder/Vision',
    smalltalk: 'Smalltalk',
    short: 'Kurzes',
    general: 'Allgemeines',
}

export interface TaskSignals {
    content: string
    hasImage?: boolean
    intentKind?: ActionIntent['kind']
    /** Caller knows the turn carries private material (desktop context, customer file, …). */
    privateContext?: boolean
}

export interface TaskClassification {
    taskClass: TaskModelClass
    private: boolean
}

// Letter-aware word boundaries: JavaScript's \b does not know umlauts.
const W = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'iu')

const SMALLTALK = W("hallo|hi|hey|servus|moin|grüß dich|grüss dich|guten (?:morgen|tag|abend)|gute nacht|wie geht'?s|wie geht es dir|was machst du|alles gut|na du")
const PRIVATE = W('gedächtnis|erinnerst du dich|erinnerung(?:en)?|memory|memories|weißt du noch|kunde|kunden|kundin|kundendaten|kundenliste|kundenkartei|kontakte?|adresse|telefonnummer|passwort|passwörter|geheim|privat\\w*|persönlich\\w*|tagebuch|gesundheit|familie|kontoauszug|rechnung(?:en)?')
const DEBUG = W('stack ?trace|traceback|exception|typeerror|referenceerror|syntaxerror|segfault|segmentation fault|null ?pointer|debugg?\\w*|fehlersuche|bug(?:s|fix)?|crash\\w*|stürzt \\w* ?ab|schlägt fehl|schlagen fehl|build (?:ist )?rot|tests? (?:sind |ist )?rot|failing|fails?|ursache (?:für|des|der)|warum (?:crasht|stürzt|hängt|läuft .{0,20} nicht)')
const REFACTOR = W('refactor\\w*|umbau\\w*|bau\\w* .{0,60} um|umstrukturier\\w*|restrukturier\\w*|migrier\\w*|migration|mehrere dateien|architektur\\w*|modularisier\\w*|aufteil\\w* .{0,30} (?:module|dateien)')
const CODE = W('code|quellcode|funktion|methode|klasse|programmier\\w*|implementier\\w*|skript|script|typescript|javascript|python|rust|golang|java|sql|regex|api|endpoint|unit-?tests?|compile\\w*|kompilier\\w*|npm|vitest|pull request|commit|git')

/** Deterministic classification. Order matters: pictures first, then the
 * smalltalk short-cut, then hard debugging, refactors, code. */
export function classifyTaskModel(signals: TaskSignals): TaskClassification {
    const text = String(signals.content || '').replace(/\s+/g, ' ').trim()
    const isPrivate = Boolean(signals.privateContext) || PRIVATE.test(text)
    if (signals.hasImage || signals.intentKind === 'screenshot' || signals.intentKind === 'image-generation') {
        return { taskClass: 'vision', private: true }
    }
    if (/```/.test(text)) return { taskClass: DEBUG.test(text) ? 'debug' : 'code', private: isPrivate }
    if (isConversationalClosure(text) || (text.length <= 80 && SMALLTALK.test(text) && !CODE.test(text))) {
        return { taskClass: 'smalltalk', private: isPrivate }
    }
    if (DEBUG.test(text)) return { taskClass: 'debug', private: isPrivate }
    if (REFACTOR.test(text)) return { taskClass: 'refactor', private: isPrivate }
    if (CODE.test(text)) return { taskClass: 'code', private: isPrivate }
    if (text.length <= 120) return { taskClass: 'short', private: isPrivate }
    return { taskClass: 'general', private: isPrivate }
}

export interface TaskModelDecisionInput {
    signals: TaskSignals
    /** Request-scoped role from authentication, never from model output. */
    permission: string | undefined
    codexEnabled: boolean
    /** undefined = not probed yet; the Codex client probes and falls back itself. */
    codexAvailable?: boolean
    codexQuotaExhausted?: boolean
    /** Explicit owner yes for this turn to let private text leave the Spark. */
    ownerApprovedExternal?: boolean
}

export interface TaskModelDecision {
    target: TaskModelTarget
    /** What the table would pick if Codex were switched on and reachable. */
    wouldBe: TaskModelTarget
    taskClass: TaskModelClass
    private: boolean
    rule: TaskModelRuleId
    reason: string
    /** User-facing message when a Codex task falls back to local. */
    notice?: string
}

export type TaskModelRuleId =
    | 'R1-vision-local' | 'R2-private-local' | 'R3-light-local' | 'R4-non-owner-local'
    | 'R5-disabled' | 'R6-quota-local' | 'R7-unavailable-local' | 'R8-codex'

interface RuleContext {
    cls: TaskClassification
    input: TaskModelDecisionInput
}

interface TaskModelRule {
    id: TaskModelRuleId
    when: string
    target: TaskModelTarget
    matches: (ctx: RuleContext) => boolean
    reason: (ctx: RuleContext) => string
    notice?: string
}

const isCodexTask = (cls: TaskClassification) => CODEX_TASK_CLASSES.includes(cls.taskClass)

/** First matching rule wins. Exactly one rule routes to Codex, and it is last. */
export const TASK_MODEL_RULES: readonly TaskModelRule[] = [
    {
        id: 'R1-vision-local', target: 'local', when: 'Bild, Screenshot oder Bilderzeugung',
        matches: ({ cls }) => cls.taskClass === 'vision',
        reason: () => 'Bilder und Screenshots verlassen den Spark nicht; lokales Modell.',
    },
    {
        id: 'R2-private-local', target: 'local', when: 'Privates (Memory, Kundendaten) ohne Owner-Ja',
        matches: ({ cls, input }) => cls.private && !(input.ownerApprovedExternal && input.permission === 'owner'),
        reason: () => 'Private Inhalte verlassen den Spark nicht ohne Owner-Ja; lokales Modell.',
    },
    {
        id: 'R3-light-local', target: 'local', when: 'Smalltalk, Kurzes, Allgemeines',
        matches: ({ cls }) => !isCodexTask(cls),
        reason: ({ cls }) => `${TASK_CLASS_LABELS[cls.taskClass]} läuft lokal.`,
    },
    {
        id: 'R4-non-owner-local', target: 'local', when: 'Codex-Aufgabe, aber nicht Owner',
        matches: ({ input }) => input.permission !== 'owner',
        reason: () => 'Codex ist nur für den Owner; lokales Modell.',
    },
    {
        id: 'R5-disabled', target: 'local', when: 'Codex-Aufgabe, codex.enabled=false',
        matches: ({ input }) => !input.codexEnabled,
        reason: ({ cls }) => `${TASK_CLASS_LABELS[cls.taskClass]}: wäre Codex, aber aus (codex.enabled=false); lokales Modell.`,
    },
    {
        id: 'R6-quota-local', target: 'local', when: 'Codex-Aufgabe, Quote erschöpft',
        matches: ({ input }) => Boolean(input.codexQuotaExhausted),
        reason: () => 'Codex-Quote erschöpft; Rückfall auf lokal.',
        notice: 'Codex-Quote ist erschöpft – ich arbeite lokal weiter.',
    },
    {
        id: 'R7-unavailable-local', target: 'local', when: 'Codex-Aufgabe, Codex nicht erreichbar',
        matches: ({ input }) => input.codexAvailable === false,
        reason: () => 'Codex nicht verfügbar; Rückfall auf lokal.',
        notice: 'Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.',
    },
    {
        id: 'R8-codex', target: 'codex', when: 'Code, größere Umbauten, schwierige Fehlersuche (Owner, an, erreichbar)',
        matches: () => true,
        reason: ({ cls }) => `${TASK_CLASS_LABELS[cls.taskClass]} für den Owner: Codex (lokal als Rückfall bereit).`,
    },
]

export function decideTaskModel(input: TaskModelDecisionInput): TaskModelDecision {
    return decideTaskModelFor(classifyTaskModel(input.signals), input)
}

/** Same table for an already known classification (used by /modelle per task class). */
export function decideTaskModelFor(cls: TaskClassification, input: TaskModelDecisionInput): TaskModelDecision {
    const ctx: RuleContext = { cls, input }
    const rule = TASK_MODEL_RULES.find(candidate => candidate.matches(ctx))!
    const blockedBeforeSwitch = ['R1-vision-local', 'R2-private-local', 'R3-light-local', 'R4-non-owner-local'].includes(rule.id)
    return {
        target: rule.target,
        wouldBe: blockedBeforeSwitch ? 'local' : 'codex',
        taskClass: cls.taskClass,
        private: cls.private,
        rule: rule.id,
        reason: rule.reason(ctx),
        notice: rule.notice,
    }
}

/** Notice for a Codex call that failed at runtime and fell back to local. */
export function codexFallbackNotice(reason: string): string {
    if (/quota|quote|usage limit|rate.?limit|\b429\b|insufficient|limit reached|kontingent/i.test(reason)) {
        return 'Hinweis: Codex-Quote ist erschöpft – ich arbeite lokal weiter.'
    }
    return 'Hinweis: Codex ist gerade nicht erreichbar oder nicht verfügbar – ich arbeite lokal weiter.'
}

export interface CodexRoutingStatusInput {
    enabled: boolean
    available: boolean
    permission: string | undefined
    activeNodeId?: string
    fallbackLabel: string
    localInstalled?: boolean
}

const CODEX_KINDS = CODEX_TASK_CLASSES.map(cls => TASK_CLASS_LABELS[cls]).join(', ')
const LOCAL_KINDS = 'Smalltalk, Kurzes, Bilder/Vision und Privates'

/** Truthful /codex status: aus / verfügbar / wird für Aufgabenart X gewählt. */
export function describeCodexRouting(status: CodexRoutingStatusInput): string {
    const login = status.available
        ? `✅ Anmeldung: verfügbar und angemeldet${status.activeNodeId ? ` auf \`${status.activeNodeId}\`` : ''}`
        : `❌ Anmeldung: auf keinem erreichbaren Node verfügbar${status.localInstalled === false ? ' (auf diesem Main nicht installiert)' : status.localInstalled ? ' (Anmeldung: /codex login)' : ''}`
    const lines = ['Codex für deinen Nova-User:']
    if (!status.enabled) {
        lines.push('⏸️ Codex-Routing: aus (codex.enabled=false)', login,
            `${CODEX_KINDS}: wäre Codex, aber aus → lokal über ${status.fallbackLabel}`,
            `${LOCAL_KINDS}: lokal über ${status.fallbackLabel}`,
            'Einschalten kann nur der Owner (codex.enabled=true).')
        return lines.join('\n')
    }
    if (status.permission !== 'owner') {
        lines.push('🔒 Codex-Routing: an, aber nur für den Owner', `Deine Anfragen laufen lokal über ${status.fallbackLabel}.`)
        return lines.join('\n')
    }
    if (!status.available) {
        lines.push('⚠️ Codex-Routing: an, aber Codex nicht verfügbar', login,
            `Alle Aufgaben laufen lokal über ${status.fallbackLabel}; Code-Aufträge melden den Rückfall.`)
        return lines.join('\n')
    }
    lines.push('▶️ Codex-Routing: an', login,
        `Codex wird für ${CODEX_KINDS} gewählt.`,
        `${LOCAL_KINDS} bleiben lokal über ${status.fallbackLabel}.`,
        'Bei Ausfall oder erschöpfter Quote: Rückfall auf lokal, mit Meldung.')
    return lines.join('\n')
}

/** Routing-site entry for nova-runner. Role comes from the request-scoped
 * LLM principal (authentication), never from the model. */
export function decideRunnerTaskModel(params: {
    content: string
    hasImage: boolean
    intentKind?: ActionIntent['kind']
    permission: string | undefined
    codexConfig?: { enabled?: boolean } | null
}): TaskModelDecision {
    return decideTaskModel({
        signals: { content: params.content, hasImage: params.hasImage, intentKind: params.intentKind },
        permission: params.permission,
        codexEnabled: params.codexConfig?.enabled === true,
    })
}

// ---------------------------------------------------------------------------
// Phase 6d — Multi-Router (extends the table above, never replaces it)
// ---------------------------------------------------------------------------
//
// Stage A, hard filters (code only, no model output can loosen them):
//   - picture / private / memory content → only `lokal` endpoints
//   - not owner → only `lokal`
//   - Codex only where R1–R8 would pick Codex (unchanged rules)
//   - other cloud models only within the daily budget (default 0 € = none);
//     unknown cost counts as expensive
//   - the capability the task needs must be proven (probe/ledger/rule)
// Stage B, scoring among the remaining endpoints that have measurements for
// this task class (≥ minSamples): success rate, then latency, then cost.
// Without measurements the R1–R8 decision stands unchanged. Off by default:
// `routing.multi.enabled=true` switches it on.

export interface MultiRouteSettings {
    enabled: boolean
    /** EUR per day for non-Codex cloud models; 0 = no cloud. */
    cloudDailyBudgetEur: number
    /** Already spent today (EUR), from the spend log. */
    cloudSpentTodayEur?: number
    /** Minimum measured runs per (endpoint, task class) before a measurement counts. */
    minSamples?: number
}

export const MULTI_ROUTE_MIN_SAMPLES = 5

/** `routing.multi` from the config. Anything but literal `true` keeps it off. */
export function readMultiRouteSettings(config: any): MultiRouteSettings {
    const multi = config?.routing?.multi || {}
    const budget = Number(multi.cloudDailyBudgetEur)
    const minSamples = Number(multi.minSamples)
    return {
        enabled: multi.enabled === true,
        cloudDailyBudgetEur: Number.isFinite(budget) && budget > 0 ? budget : 0,
        minSamples: Number.isInteger(minSamples) && minSamples >= 1 ? minSamples : MULTI_ROUTE_MIN_SAMPLES,
    }
}

export type MultiRouteTarget = TaskModelTarget | 'cloud'

export interface MultiRouteCandidate {
    id: string
    kind: EndpointKind
    model: string
    node?: string
    privacy: PrivacyClass
    costEurPerCall: number | null
    successRate?: number
    avgLatencyMs?: number
    samples?: number
    /** Reason the hard filter removed it; undefined = admissible. */
    excluded?: string
}

export interface MultiRouteDecision extends Omit<TaskModelDecision, 'target' | 'rule'> {
    target: MultiRouteTarget
    rule: TaskModelRuleId | 'M1-messung' | 'M2-raum' | 'M2-lokal-ausfall'
    /** false when routing.multi.enabled is off (pure R1–R8). */
    multi: boolean
    /** raum = a desktop room/bot profile prefers nodes (2.86 Punkt 10); 2.85 'ausfall' = every local model is down, a connected cloud model is the fallback. */
    basis: 'aus' | 'regeln' | 'messung' | 'raum' | 'ausfall'
    /** Preferred nodes given but none of them has a healthy, fitting local endpoint: shown to the user. */
    roomNotice?: string
    /** The R1–R8 decision for comparison. */
    baseline: TaskModelDecision
    /** Chosen endpoint when the measurement decided; undefined = runner default (as before). */
    endpoint?: { id: string; kind: EndpointKind; model: string; node?: string; baseUrl?: string; privacy: PrivacyClass; costEurPerCall: number | null }
    candidates: MultiRouteCandidate[]
}

const fmtPct = (value: number) => `${Math.round(value * 100)} %`

const cleanNodeIds = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 16)
    : []

export function decideMultiRoute(input: TaskModelDecisionInput, registry: ModelRegistry | null | undefined, settings: MultiRouteSettings, classification?: TaskClassification, preferredNodeIds: string[] = []): MultiRouteDecision {
    const cls = classification || classifyTaskModel(input.signals)
    const baseline = decideTaskModelFor(cls, input)
    const preferred = cleanNodeIds(preferredNodeIds)
    let roomNotice: string | undefined
    const asRules = (basis: 'aus' | 'regeln', candidates: MultiRouteCandidate[], extra = ''): MultiRouteDecision => ({
        ...baseline, multi: basis !== 'aus', basis, baseline, candidates,
        reason: extra ? `${baseline.reason} ${extra}` : baseline.reason,
        ...(roomNotice ? { roomNotice } : {}),
    })
    // 2.86 Punkt 10: a room/bot profile prefers nodes. Only LOCAL endpoints on those
    // nodes, healthy and with the proven capability; first preferred node wins
    // (measured best there if measurements exist). Codex routes stay as they are,
    // and privacy needs nothing extra: only `lokal` endpoints qualify.
    if (preferred.length && baseline.target !== 'codex') {
        const need = requiredCapability(cls.taskClass)
        const minSamples = settings?.minSamples && settings.minSamples >= 1 ? settings.minSamples : MULTI_ROUTE_MIN_SAMPLES
        const fitting = (registry?.endpoints || []).filter(ep => ep.privacy === 'lokal' && ep.health !== 'down' && ep.node
            && preferred.includes(ep.node) && hasProvenCapability(ep, need))
        if (fitting.length) {
            const rank = (ep: typeof fitting[number]) => {
                const measured = measurementFor(ep, cls.taskClass)
                return measured && measured.samples >= minSamples ? measured : null
            }
            fitting.sort((a, b) => (preferred.indexOf(a.node!) - preferred.indexOf(b.node!))
                || (Math.round(((rank(b)?.successRate) ?? -1) * 100) - Math.round(((rank(a)?.successRate) ?? -1) * 100))
                || (Number(b.health === 'ok') - Number(a.health === 'ok'))
                || a.id.localeCompare(b.id))
            const ep = fitting[0]
            const measured = rank(ep)
            const candidates: MultiRouteCandidate[] = (registry?.endpoints || []).map(item => ({
                id: item.id, kind: item.kind, model: item.model, node: item.node, privacy: item.privacy, costEurPerCall: item.costEurPerCall,
                ...(fitting.includes(item) ? {} : { excluded: `Raum bevorzugt Knoten ${preferred.join(', ')}` }),
            }))
            return {
                ...baseline,
                target: 'local',
                wouldBe: baseline.wouldBe,
                rule: 'M2-raum',
                multi: settings?.enabled === true,
                basis: 'raum',
                baseline,
                endpoint: { id: ep.id, kind: ep.kind, model: ep.model, node: ep.node, baseUrl: ep.baseUrl, privacy: ep.privacy, costEurPerCall: ep.costEurPerCall },
                candidates,
                reason: `Raum bevorzugt Knoten ${ep.node}: ${ep.model} (lokal)${measured ? `, Erfolgsquote ${fmtPct(measured.successRate)} bei ${measured.samples} Läufen` : ', ohne Messbasis'}; Regeltabelle wäre ${baseline.rule}.`,
                notice: undefined,
            }
        }
        roomNotice = `Hinweis: Bevorzugter Knoten ${preferred.join(', ')} hat gerade kein passendes lokales Modell — die Aufgabe läuft wie gewohnt.`
    }
    if (!settings?.enabled) return asRules('aus', [])

    const owner = input.permission === 'owner'
    const need = requiredCapability(cls.taskClass)
    const budget = Math.max(0, Number(settings.cloudDailyBudgetEur) || 0)
    const spent = Math.max(0, Number(settings.cloudSpentTodayEur) || 0)
    const minSamples = settings.minSamples && settings.minSamples >= 1 ? settings.minSamples : MULTI_ROUTE_MIN_SAMPLES

    const candidates: MultiRouteCandidate[] = (registry?.endpoints || []).map(ep => {
        const measured = measurementFor(ep, cls.taskClass)
        const candidate: MultiRouteCandidate = {
            id: ep.id, kind: ep.kind, model: ep.model, node: ep.node, privacy: ep.privacy, costEurPerCall: ep.costEurPerCall,
            ...(measured ? { successRate: measured.successRate, avgLatencyMs: measured.avgLatencyMs, samples: measured.samples } : {}),
        }
        const exclude = (reason: string) => ({ ...candidate, excluded: reason })
        if (ep.health === 'down') return exclude('nicht gesund (Probe/Verfügbarkeit)')
        if (!hasProvenCapability(ep, need)) return exclude(`Fähigkeit ${need} nicht belegt`)
        if (ep.privacy === 'cloud') {
            if (cls.taskClass === 'vision') return exclude('Bild bleibt lokal')
            if (cls.private) return exclude('Privates (Memory, Kundendaten) bleibt lokal')
            if (!owner) return exclude('Nicht-Owner: nur lokal')
            if (ep.kind === 'codex') {
                if (baseline.target !== 'codex') return exclude(`Codex nur nach Regeltabelle (${baseline.rule})`)
            } else {
                if (ep.costEurPerCall === null) return exclude('Kosten unbekannt (gilt als teuer)')
                if (budget <= 0) return exclude('Tagesbudget 0 € (routing.multi.cloudDailyBudgetEur)')
                if (spent + ep.costEurPerCall > budget) return exclude(`Tagesbudget erschöpft (${spent.toFixed(2)} von ${budget.toFixed(2)} €)`)
            }
        }
        return candidate
    })

    const admissible = candidates.filter(item => !item.excluded)
    // 2.85 Paket C: local first — cloud as a fallback only when every local model is
    // down. The stage-A filters above (picture, private, owner, budget, cost,
    // proven capability) apply unchanged; Codex keeps its own fallback path.
    const localUp = (registry?.endpoints || []).some(ep => ep.privacy === 'lokal' && ep.health !== 'down')
    if (!localUp && baseline.target !== 'codex') {
        const costKey = (value: number | null) => value === null ? Number.POSITIVE_INFINITY : value
        const fallback = admissible
            .filter(item => item.privacy === 'cloud' && item.kind !== 'codex')
            .sort((a, b) => ((b.successRate ?? -1) - (a.successRate ?? -1)) || (costKey(a.costEurPerCall) - costKey(b.costEurPerCall)) || a.id.localeCompare(b.id))[0]
        const ep = fallback && registry!.endpoints.find(item => item.id === fallback.id)
        if (ep) {
            return {
                ...baseline, target: 'cloud', wouldBe: baseline.wouldBe, rule: 'M2-lokal-ausfall', multi: true, basis: 'ausfall', baseline, candidates,
                endpoint: { id: ep.id, kind: ep.kind, model: ep.model, node: ep.node, baseUrl: ep.baseUrl, privacy: ep.privacy, costEurPerCall: ep.costEurPerCall },
                reason: `${TASK_CLASS_LABELS[cls.taskClass]}: kein lokales Modell erreichbar — Rückfall auf ${ep.model} (cloud, nicht-privat, Kosten ${ep.costEurPerCall ?? 'unbekannt'} €).`,
                notice: `Hinweis: Das lokale Modell ist gerade nicht erreichbar – ich nutze als Rückfall ${ep.model} (Cloud, bereinigter Auftrag ohne Memory/Verlauf).`,
            }
        }
    }
    // A Codex choice by the table stays as long as Codex itself has no measurement.
    if (baseline.target === 'codex') {
        const codex = admissible.find(item => item.kind === 'codex')
        if (!codex || !(codex.samples && codex.samples >= minSamples)) return asRules('regeln', candidates, '(Codex nach Regeltabelle; keine Codex-Messdaten)')
    }
    const measured = admissible.filter(item => (item.samples || 0) >= minSamples && item.successRate !== undefined)
    if (!measured.length) return asRules('regeln', candidates, '(keine Messdaten; Regeltabelle R1–R8)')

    const costKey = (value: number | null) => value === null ? Number.POSITIVE_INFINITY : value
    measured.sort((a, b) =>
        (Math.round((b.successRate || 0) * 100) - Math.round((a.successRate || 0) * 100))
        || ((a.avgLatencyMs ?? Infinity) - (b.avgLatencyMs ?? Infinity))
        || (costKey(a.costEurPerCall) - costKey(b.costEurPerCall))
        || a.id.localeCompare(b.id))
    const winner = measured[0]
    const ep = registry!.endpoints.find(item => item.id === winner.id)!
    const target: MultiRouteTarget = ep.privacy === 'lokal' ? 'local' : ep.kind === 'codex' ? 'codex' : 'cloud'
    const where = ep.node ? ` auf ${ep.node}` : ''
    const cost = ep.costEurPerCall === null ? 'unbekannt' : `${ep.costEurPerCall} €`
    return {
        ...baseline,
        target,
        wouldBe: baseline.wouldBe,
        rule: 'M1-messung',
        multi: true,
        basis: 'messung',
        baseline,
        endpoint: { id: ep.id, kind: ep.kind, model: ep.model, node: ep.node, baseUrl: ep.baseUrl, privacy: ep.privacy, costEurPerCall: ep.costEurPerCall },
        candidates,
        reason: `${TASK_CLASS_LABELS[cls.taskClass]}: gemessen bestes Modell ${ep.model}${where} (${ep.privacy}) — Erfolgsquote ${fmtPct(winner.successRate || 0)} bei ${winner.samples} Läufen, ${winner.avgLatencyMs} ms, Kosten ${cost}; Regeltabelle wäre ${baseline.rule}.`,
        notice: target === 'cloud' ? 'Hinweis: Diese Aufgabe läuft über ein Cloud-Modell (bereinigter Auftrag ohne Memory/Verlauf).' : baseline.notice && target !== 'local' ? baseline.notice : undefined,
    }
}

/** Runner entry for the multi-router. Role from the request-scoped principal. */
export function decideRunnerMultiRoute(params: {
    content: string
    hasImage: boolean
    intentKind?: ActionIntent['kind']
    permission: string | undefined
    codexConfig?: { enabled?: boolean } | null
    registry: ModelRegistry | null
    settings: MultiRouteSettings
    /** Desktop room / bot profile (2.86 Punkt 10). */
    preferredNodeIds?: string[]
}): MultiRouteDecision {
    return decideMultiRoute({
        signals: { content: params.content, hasImage: params.hasImage, intentKind: params.intentKind },
        permission: params.permission,
        codexEnabled: params.codexConfig?.enabled === true,
    }, params.registry, params.settings, undefined, params.preferredNodeIds || [])
}
