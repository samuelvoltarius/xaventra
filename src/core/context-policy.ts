import { runtimeProfile } from './runtime-profile.js'
import { actionRequestText, isConversationOnly } from './action-intent.js'
import { compoundRemainder, mentionsEnvironment } from './request-capabilities.js'

export type CognitiveMode = 'fast' | 'balanced' | 'deep' | 'research'

export interface ContextPolicy {
    /** Compatibility view used by the existing context loaders. */
    mode: 'lean' | 'standard' | 'deep'
    /** Canonical cognitive mode for this turn. */
    cognitiveMode: CognitiveMode
    reasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
    taskClass: 'conversation' | 'lookup' | 'action' | 'analysis' | 'research' | 'recovery'
    uncertainty: number
    novelty: number
    researchRequired: boolean
    predictive: boolean
    behavioral: boolean
    hardware: boolean
    mesh: boolean
    longTermMemory: boolean
    memoryDepth: 'none' | 'working' | 'long-term'
    plannerPaths: 1 | 2 | 3
    maxSubagents: number
    timeBudgetMs: number
    maxPromptChars: number
    executionBudget: {
        timeoutMs: number
        maxToolCalls: number
        maxOutputTokens: number
    }
    reasons: string[]
}

const SOCIAL = /^(?:hallo|hi|hey|guten (?:morgen|abend|tag)|danke|ok(?:ay)?|super|perfekt|test)[!. ]*$/i
const ACTION = /\b(?:mach|mache|bau|baue|implementier|änder|aender|fix|reparier|installier|deploy|rollout|start|stop|lösch|loesch|send|schick|erstell|schreib|verschieb|aktualisier)\w*/i
const ANALYSIS = /\b(?:analys|vergleich|bewert|prüf|pruef|audit|debug|architekt|strategie|plan|ursache|warum|erklär|erklaer)\w*/i
const RESEARCH = /\b(?:recherch|research|online|internet|web|aktuell|neueste|stand der technik|state of the art|heute|quelle|beleg|dokumentation|docs|github)\w*/i
const RECOVERY = /\b(?:fehler|fehlgeschlagen|absturz|crash|resume|fortsetz|wiederherstell|rollback|failover|recovery|offline|timeout)\w*/i
const MEMORY = /\b(?:erinner|früher|frueher|vorher|zuvor|zuletzt|weitermachen|mach weiter|wo waren wir|was (?:ist|war) offen|memory|wissen|merk(?:e)? dir|speicher|vergiss (?:das )?nie|präferenz|praeferenz|bevorzuge|ziel ist)\w*/i
const MESH = /\b(?:mesh|node|server|remote|ssh|spark|jetson|pi5?|ns[12]|nas|failover|vllm)\b/i
const HARDWARE = /\b(?:hardware|gpu|cpu|ram|vram|cuda|vulkan|computer|rechner)\b/i
const UNCERTAIN = /\b(?:vielleicht|eventuell|vermutlich|glaube|denke|unsicher|irgendwie|oder so|keine ahnung|weiß nicht|weiss nicht|maybe|probably|not sure)\b/i
const AMBIGUOUS = /\b(?:das|dies|dort|da|ihn|sie|es|that|this|there|it)\b/i
const MULTI_STEP = /\b(?:zuerst|danach|anschließend|anschliessend|gleichzeitig|mehrere|alle|komplett|end-to-end|1\s*[-–]\s*10)\b/i
const HIGH_STAKES = /\b(?:produktion|production|security|sicherheit|medizin|recht|finanz|deployment|datenbank|credential|oauth|token|kritisch)\w*/i

/** 8 tool calls per part, at most 16: a two-part request must not run into the one-part budget. */
const COMPOUND_MAX_TOOL_CALLS = 16
function compoundBudget<T extends { maxToolCalls: number }>(compound: boolean, budget: T): T {
    return compound && budget.maxToolCalls < COMPOUND_MAX_TOOL_CALLS ? { ...budget, maxToolCalls: COMPOUND_MAX_TOOL_CALLS } : budget
}

function clamp(value: number): number {
    return Math.max(0, Math.min(1, value))
}

/**
 * Canonical per-turn cognitive controller.
 *
 * This is deliberately deterministic and cheap: it decides how much context,
 * planning and execution budget Nova may spend before any model call. Model
 * output is never used to grant a larger autonomy or evidence budget.
 */
export function selectContextPolicy(content: string, hasImage = false): ContextPolicy {
    const text = String(content || '').trim()
    const lower = text.toLowerCase()
    const wordCount = lower ? lower.split(/\s+/).length : 0
    const isSocial = SOCIAL.test(text)
    const isAction = ACTION.test(actionRequestText(lower))
    const isAnalysis = ANALYSIS.test(lower)
    // "Current" can refer to the latest fact in this conversation, not fresh
    // external knowledge. Keep this exception narrow; mixed web/action requests
    // retain their ordinary effort and evidence requirements.
    const conversationRecall = wordCount <= 60
        && /^(?:wie lautet|was ist|welche?\b)/i.test(lower)
        && /\b(?:aus|in) (?:unserem|dem|diesem) (?:gespräch|gespraech|chat)\b/i.test(lower)
        && !/\b(?:online|internet|web|quelle\w*|beleg\w*|recherch\w*|research|heute|neueste\w*|preis|version|release|dokumentation|docs|github)\b/i.test(lower)
        && !isAction && !isAnalysis && !RECOVERY.test(lower)
        && !MULTI_STEP.test(lower) && !MESH.test(lower) && !HARDWARE.test(lower)
    const isResearch = RESEARCH.test(lower) && !conversationRecall
    const isRecovery = RECOVERY.test(lower)
    const needsMemory = MEMORY.test(lower) || conversationRecall
    const mesh = MESH.test(lower) || mentionsEnvironment(lower)
    const hardware = hasImage || HARDWARE.test(lower)
    const multiStep = MULTI_STEP.test(lower) || (text.match(/[\n;]+/g)?.length || 0) >= 2
    const highStakes = HIGH_STAKES.test(lower)
    // 2.89.3: two tasks in one request ("Wie spät ist es und wie ist das Wetter?") get the budget per part.
    const compound = compoundRemainder(text) !== null

    const uncertainty = clamp(
        (UNCERTAIN.test(lower) ? 0.45 : 0)
        + (AMBIGUOUS.test(lower) && wordCount < 12 ? 0.25 : 0)
        + (text.endsWith('?') && wordCount < 5 && !isSocial ? 0.1 : 0)
        + (needsMemory ? -0.1 : 0),
    )
    const novelty = clamp(
        (isResearch ? 0.45 : 0)
        + (isAnalysis ? 0.2 : 0)
        + (text.length > 800 ? 0.2 : 0)
        + (multiStep ? 0.2 : 0)
        + (mesh || hardware ? 0.1 : 0),
    )

    let score = 0
    if (wordCount > 18) score += 18
    if (text.length > 600) score += 18
    if (isAction) score += 12
    if (isAnalysis) score += 40
    if (isResearch) score += 28
    if (isRecovery) score += 18
    if (multiStep) score += 18
    if (highStakes) score += 18
    if (mesh || hardware) score += 10
    score += Math.round(uncertainty * 16)
    if (isSocial) score = 0

    const researchRequired = isResearch || (/\b(?:aktuell|heute|neueste|stand der technik|ende\s+20\d\d|preis|version|release)\b/i.test(lower) && !isSocial && !conversationRecall)
    const cognitiveMode: CognitiveMode = researchRequired
        ? 'research'
        : score >= 40 ? 'deep'
        : score >= 18 ? 'balanced'
        : 'fast'
    const mode: ContextPolicy['mode'] = cognitiveMode === 'fast'
        ? 'lean'
        : cognitiveMode === 'balanced' ? 'standard' : 'deep'
    const longTermMemory = needsMemory || mode !== 'lean'

    const reasons = [
        isSocial ? 'social fast path' : '',
        isAction ? 'action requested' : '',
        isAnalysis ? 'analysis required' : '',
        isResearch ? 'fresh external evidence requested' : '',
        isRecovery ? 'recovery context detected' : '',
        needsMemory ? 'cross-session context relevant' : '',
        multiStep ? 'multi-step task' : '',
        highStakes ? 'high-impact domain' : '',
        mesh ? 'mesh state relevant' : '',
        hardware ? 'hardware state relevant' : '',
    ].filter(Boolean)

    return {
        mode,
        cognitiveMode,
        reasoningEffort: cognitiveMode === 'fast' ? 'minimal'
            : cognitiveMode === 'balanced' ? 'low'
            : cognitiveMode === 'deep' ? 'medium' : 'high',
        taskClass: isRecovery ? 'recovery'
            : researchRequired ? 'research'
            : isAnalysis ? 'analysis'
            : isAction ? 'action'
            : isSocial || isConversationOnly(text) ? 'conversation' : 'lookup',
        uncertainty,
        novelty,
        researchRequired,
        predictive: mode !== 'lean',
        behavioral: mode === 'deep' || /stimmung|präferenz|praeferenz|stil/.test(lower),
        hardware,
        mesh,
        longTermMemory,
        memoryDepth: longTermMemory ? (mode === 'deep' ? 'long-term' : 'working') : 'none',
        plannerPaths: cognitiveMode === 'fast' ? 1 : cognitiveMode === 'balanced' ? 2 : 3,
        maxSubagents: cognitiveMode === 'fast' ? 0 : cognitiveMode === 'balanced' ? 1 : 3,
        timeBudgetMs: mode === 'deep' ? 1_800 : mode === 'standard' ? 900 : 250,
        maxPromptChars: mode === 'deep' ? 28_000 : mode === 'standard' ? 20_000 : 12_000,
        // In NovaOS ist eine harmlos klingende Bitte ("installier X", "geh auf
        // google.at") oft ein mehrstufiger Systemvorgang: apt update, install,
        // Verifikation — oder Browser starten, laden, lesen. Mit 60 s / 4 Aufrufen
        // im schnellen Modus bricht das mit "timeout budget exceeded" ab, obwohl
        // Nova alles richtig macht. Ausserhalb von NovaOS gelten kleinere, aber
        // fuer mehrstufige Auftraege ausreichende Budgets (2.89).
        // These are generation allowances, shared across the native run. An
        // optional caller maxTokens remains a separate input+output ceiling.
        executionBudget: compoundBudget(compound, runtimeProfile() === 'novaos'
            ? (cognitiveMode === 'fast'
                ? { timeoutMs: 600_000, maxToolCalls: 12, maxOutputTokens: 4_096 }
                : cognitiveMode === 'balanced'
                    ? { timeoutMs: 1_200_000, maxToolCalls: 30, maxOutputTokens: 8_192 }
                    : { timeoutMs: 2_400_000, maxToolCalls: 60, maxOutputTokens: 16_384 })
            // 2.89: the normal Main got 60 s / 4 calls even for a simple
            // device task with a check afterwards; NovaOS stays the upper bound.
            : cognitiveMode === 'fast'
                ? { timeoutMs: 180_000, maxToolCalls: 8, maxOutputTokens: 2_048 }
                : cognitiveMode === 'balanced'
                    ? { timeoutMs: 600_000, maxToolCalls: 24, maxOutputTokens: 4_096 }
                    : { timeoutMs: 900_000, maxToolCalls: 40, maxOutputTokens: 8_192 }),
        reasons: reasons.length ? reasons : ['ordinary lookup'],
    }
}

/** Compact model-facing policy. It allocates effort without exposing hidden reasoning. */
export function buildCognitivePrompt(policy: ContextPolicy): string {
    const instructions = [
        `Arbeitsmodus: ${policy.cognitiveMode}; Aufgabentyp: ${policy.taskClass}; Denktiefe: ${policy.reasoningEffort}.`,
        policy.plannerPaths > 1
            ? `Prüfe intern bis zu ${policy.plannerPaths} sinnvolle Lösungswege und wähle anhand von Evidence, Risiko, Dauer und Rückweg.`
            : 'Antworte direkt und knapp; plane nur, wenn ein Tool wirklich nötig ist.',
        policy.researchRequired
            ? 'Aktuelle oder veränderliche Behauptungen (aktuell / neueste / Stand der Technik / Ende <Jahr>) immer mit Websuche belegen, Datum aus der Systemzeit nennen. Ohne Suchergebnis ehrlich „mein Wissen kann veraltet sein“. Empfehlungen nur zur Hardware des Knotens (GPU/VRAM vs. CPU-only: kein Großmodell auf purem CPU-Knoten). Kein Install-Angebot ohne passende Hardware.'
            : '',
        policy.uncertainty >= 0.5
            ? 'Löse Unsicherheit zuerst mit vorhandenem Kontext oder read-only Recherche; falls sie entscheidend bleibt, stelle genau eine gezielte Rückfrage.'
            : '',
        'Gib niemals interne Gedankengänge aus. Zeige stattdessen Ergebnis, Belege und relevante Unsicherheit.',
        'Halte explizite Antwortformate ein (z.B. nur eine Kennung, kein Zusatztext). Bei Korrekturen gilt die neueste Angabe; wiederhole überholte Werte nicht ungefragt.',
        'Ist eine Freigabe offen, nenne immer den laufenden Einmal-Code-Schritt („Schick mir jetzt den Code von der /freigabe-Zeile“). Auffordere nie zu einem neuen /freigabe — derselbe Code gilt weiter.',
    ].filter(Boolean)
    return `## Adaptive Cognitive Policy\n${instructions.join('\n')}`
}
