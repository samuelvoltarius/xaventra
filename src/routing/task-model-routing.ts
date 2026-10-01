import type { ActionIntent } from '../core/action-intent.js'
import { isConversationalClosure } from '../core/action-intent.js'

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
    const cls = classifyTaskModel(input.signals)
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
