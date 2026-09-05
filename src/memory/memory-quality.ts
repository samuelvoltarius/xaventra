const BAD = /(?:schiefgelaufen|entschuldigung|versuch(?:e)? es nochmal|ich arbeite noch|llm\/tools|antwort gesendet|task completed|trace:|tool result|error:|warning:|konnte .* nicht zuverlässig|keine ahnung|soll ich\??$)/i
const LOG_OR_CODE = /(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\[INFO\]|\[ERROR\]|stack trace|=>|===|```)/i
const QUESTION_OR_COMMAND = /\?$|^(?:warum|wieso|wie|was|wer|wann|wo|mach|mache|starte|prüf|prüfe|installier|such|sende|zeig)\b/i

export type MemoryQueryIntent =
    | 'overview'
    | 'identity'
    | 'preference'
    | 'project'
    | 'instruction'
    | 'continuity'
    | 'specific'

export interface MemoryTurnDecision {
    intent: MemoryQueryIntent
    observe: boolean
    recall: boolean
    reason: 'explicit-memory' | 'personal-fact' | 'goal-or-rule' | 'recall' | 'contextual'
}

const TOKEN_ALIASES: Record<string, string> = {
    heisse: 'name', name: 'name',
    mag: 'preference', bevorzuge: 'preference', bevorzugt: 'preference',
    praeferenz: 'preference', preference: 'preference', prefer: 'preference',
    projekte: 'project', projekt: 'project', project: 'project',
    anweisung: 'instruction', anweisungen: 'instruction', regel: 'instruction',
    regeln: 'instruction', merke: 'instruction', merken: 'instruction', remember: 'instruction',
    vorher: 'continuity', zuvor: 'continuity', weiter: 'continuity', offen: 'continuity',
    zuletzt: 'continuity', letzte: 'continuity', weitermachen: 'continuity',
    modelle: 'modell', models: 'modell', model: 'modell',
    laeuft: 'laufen', running: 'laufen', runs: 'laufen',
}

function normalizedWords(value: string): Set<string> {
    const stop = new Set([
        'aber', 'auch', 'dann', 'dass', 'eine', 'einen', 'einer', 'haben', 'hier',
        'nicht', 'oder', 'sich', 'sind', 'sein', 'und', 'warum', 'wird', 'wurde',
        'kann', 'mach', 'mein', 'meine', 'mich', 'ueber', 'about', 'what', 'you',
        'know', 'noch', 'weisst',
    ])
    const raw = value.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .match(/[\p{L}\p{N}_-]{3,}/gu) || []
    return new Set(raw
        .filter(word => !stop.has(word))
        .map(word => TOKEN_ALIASES[word] || word)
        .map(word => word.replace(/(?:ern|en|er|es|e|s)$/i, match =>
            word.length - match.length >= 4 ? '' : match)))
}

export function classifyMemoryQuery(query: string): MemoryQueryIntent {
    const value = query.trim().toLowerCase()
    if (/(?:was|welche).*(?:weißt|weisst|kennst).*(?:über|ueber)?\s*(?:mich|mir)|erinnerst du dich|what do you (?:know|remember) about me/.test(value)) {
        return 'overview'
    }
    if (/wer bin ich|wie hei(?:ß|ss)e ich|mein name|my name|who am i/.test(value)) return 'identity'
    if (/bevorzug|präferenz|praeferenz|was mag ich|what do i (?:like|prefer)/.test(value)) return 'preference'
    if (/projekt|woran arbeite|was baue|project|working on/.test(value)) return 'project'
    if (/anweisung|regel|was sollst du|wichtig|merk dir|instruction|rule/.test(value)) return 'instruction'
    if (/wo waren wir|woran waren wir|was (?:ist|war) offen|mach weiter|weitermachen|zuletzt|vorher|zuvor|continue|last time|open task/.test(value)) {
        return 'continuity'
    }
    return 'specific'
}

/**
 * Cheap deterministic gate for the conversational hot path. It decides
 * whether a turn may contain durable user information; truth and lifecycle
 * remain the responsibility of Memory Governance.
 */
export function decideMemoryTurn(message: string): MemoryTurnDecision {
    const value = message.trim().toLowerCase()
    const intent = classifyMemoryQuery(message)
    const explicitMemory = /\b(?:merk(?:e)? dir|merken|speicher(?:e)?|remember|vergiss (?:das )?nie)\b/i.test(value)
    const personalFact = /\b(?:ich|mein(?:e|er|en|em|es)?|wir|unser(?:e|er|en|em|es)?)\b.{0,90}\b(?:bin|hei(?:ß|ss)e?|habe|hat|mag|liebe|bevorzug|nutze|verwende|arbeite|baue|entwickle|wohne|lebe|gehört|ist|sind)\b/i.test(value)
    const goalOrRule = /\b(?:ziel ist|mein ziel|unser ziel|wichtig(?: ist)?|ab jetzt|immer|niemals|nie|sollst du|darfst du nicht|nicht ändern)\b/i.test(value)
    const recall = intent !== 'specific'
        || /\b(?:erinner|gemerkt|wei(?:ß|ss)t du|kennst du|mein(?:e|er|en|em|es)?\s+\w+\??$)\b/i.test(value)

    if (explicitMemory) return { intent, observe: true, recall: true, reason: 'explicit-memory' }
    if (personalFact) return { intent, observe: true, recall, reason: 'personal-fact' }
    if (goalOrRule) return { intent, observe: true, recall: true, reason: 'goal-or-rule' }
    if (recall) return { intent, observe: false, recall: true, reason: 'recall' }
    return { intent, observe: false, recall: true, reason: 'contextual' }
}

/** Returns the user-owned topic to forget, or `__all__` for an explicit wipe. */
export function parseNaturalMemoryForget(message: string): string | null {
    const value = message.trim()
    if (/^vergiss\s+(?:bitte\s+)?nicht\b/i.test(value) || /vergiss (?:das )?nie/i.test(value)) return null
    if (/^(?:vergiss|lösche|loesche)\s+(?:bitte\s+)?(?:alles\s+(?:über|ueber|zu)\s+mich|alle\s+(?:meine[nr]?\s+)?erinnerungen)\s*[.!]?$/i.test(value)) {
        return '__all__'
    }
    const match = value.match(
        /^(?:vergiss|lösche|loesche)\s+(?:bitte\s+)?(?:die\s+erinnerung\s+(?:an|über|ueber)\s+|aus\s+deinem\s+gedächtnis\s+|dass\s+)?(.{3,240}?)[.!]?$/i,
    )
    return match?.[1]?.trim() || null
}

export function memoryKindBonus(query: string, kind: string): number {
    const intent = classifyMemoryQuery(query)
    if (intent === 'overview') {
        return ['identity', 'preference', 'project', 'skill', 'relationship', 'instruction'].includes(kind) ? 2.4 : 0.8
    }
    if (intent === 'identity') return kind === 'identity' ? 5 : 0
    if (intent === 'preference') return kind === 'preference' ? 5 : 0
    if (intent === 'project') return kind === 'project' ? 5 : kind === 'context' ? 1.5 : 0
    if (intent === 'instruction') return kind === 'instruction' ? 5 : kind === 'preference' ? 1.5 : 0
    if (intent === 'continuity') return ['project', 'instruction', 'context', 'learning'].includes(kind) ? 2 : 0
    return 0
}

export function isDurableMemoryCandidate(value: unknown): value is string {
    if (typeof value !== 'string') return false
    const text = value.trim()
    if (text.length < 25 || text.length > 300 || text.split(/\s+/).length < 5) return false
    if (BAD.test(text) || LOG_OR_CODE.test(text) || QUESTION_OR_COMMAND.test(text)) return false
    if (/https?:\/\/|[*#\[\]{}|<>]/i.test(text)) return false
    return true
}

export function memoryRelevance(query: string, fact: string): number {
    const q = normalizedWords(query), f = normalizedWords(fact)
    if (!q.size || !f.size) return 0
    return [...q].filter(w => f.has(w)).length / Math.max(2, Math.min(q.size, f.size))
}

/** Stable profile facts should not decay; operational/context memories must. */
export function memoryFreshnessBonus(kind: string, updatedAt: number, now = Date.now()): number {
    if (['identity', 'preference', 'instruction', 'relationship'].includes(kind)) return 0.75
    const ageDays = Math.max(0, now - updatedAt) / 86_400_000
    const halfLife = kind === 'operational' ? 1 : kind === 'context' ? 14 : 90
    return Math.max(0, 1.5 * Math.exp(-Math.LN2 * ageDays / halfLife))
}

/** MMR-like deterministic diversity: avoid returning many near-identical facts. */
export function selectDiverseMemories<T extends { memoryKey: string; content: string; score: number }>(items: T[], limit: number): T[] {
    const selected: T[] = []
    for (const item of items) {
        const duplicate = selected.some(existing => existing.memoryKey === item.memoryKey || memoryRelevance(existing.content, item.content) >= 0.82)
        if (!duplicate) selected.push(item)
        if (selected.length >= limit) break
    }
    return selected
}
