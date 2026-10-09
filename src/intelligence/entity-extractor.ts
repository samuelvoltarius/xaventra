/**
 * Entity Extractor
 * 
 * Extracts meaningful entities from conversations:
 * - People names
 * - Project names  
 * - File paths
 * - Tool names
 * - Technical terms
 */

// ============================================
// Types
// ============================================

export interface ExtractedEntities {
    people: string[]
    projects: string[]
    paths: string[]
    tools: string[]
    technologies: string[]
    commands: string[]
}

export interface ConversationContext {
    entities: ExtractedEntities
    currentProject?: string
    lastMentionedPath?: string
    extractedAt: number
}

// ============================================
// Extraction Patterns
// ============================================

const PATTERNS = {
    // File/directory paths
    paths: [
        /(?:^|\s)((?:\/|[A-Z]:\\|\.\.?\/)[^\s"'<>|]+)/gm,
        /['"]([^'"]*(?:\.ts|\.js|\.py|\.json|\.md|\.tsx|\.jsx)['"]*)/g,
        /\b([a-zA-Z_][a-zA-Z0-9_/-]*(?:\/[a-zA-Z_][a-zA-Z0-9_/-]*)*\.(?:ts|js|py|json|md|tsx|jsx|go|rs|java|cpp|c|h))\b/g,
    ],

    // Project-like names (lowercase with hyphens)
    projects: [
        /\b([a-z][a-z0-9-]+(?:-[a-z0-9]+)+)\b/g,  // nova-core, prc-ai-saas
        /(?:projekt|project|repo)\s+['"]?(\w+)['"]?/gi,
    ],

    // People names (capitalized words not at sentence start)
    people: [
        /(?:^|\.\s+)([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)*)/gm,
        /(?:@|von|für|an)\s*([A-ZÄÖÜ][a-zäöüß]+)/g,
    ],

    // Tools (from known list + [TOOL:name] pattern)
    tools: [
        /\[TOOL:(\w+)\(/g,
        /(?:tool|befehl|command)\s+['"]?(\w+)['"]?/gi,
    ],

    // Technologies
    technologies: [
        /\b(TypeScript|JavaScript|Python|React|Next\.?js|Node\.?js|NestJS|PostgreSQL|MongoDB|Redis|Docker|Git)\b/gi,
        /\b(npm|pip|yarn|pnpm|bun)\b/gi,
    ],

    // Shell commands
    commands: [
        /(?:run|execute|ausführen)\s+['"`]([^'"`]+)['"`]/gi,
        /\$\s*(.+?)(?:\n|$)/gm,
    ],
}

// Known tool names for reference
const KNOWN_TOOLS = [
    'run_command', 'read_file', 'write_file', 'list_directory',
    'web_search', 'tavily_search', 'brave_search', 'google_search',
    'ssh_command', 'remember', 'recall', 'setreminder', 'browse_url',
]

// ============================================
// Extractor Functions
// ============================================

function extractWithPatterns(text: string, patterns: RegExp[]): string[] {
    const results = new Set<string>()

    for (const pattern of patterns) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(text)) !== null) {
            const value = match[1] || match[0]
            if (value && value.length > 1 && value.length < 100) {
                results.add(value.trim())
            }
        }
    }

    return Array.from(results)
}

/**
 * Extract all entities from a text
 */
export function extractEntities(text: string): ExtractedEntities {
    return {
        paths: extractWithPatterns(text, PATTERNS.paths),
        projects: extractWithPatterns(text, PATTERNS.projects),
        people: extractWithPatterns(text, PATTERNS.people)
            .filter(name => !KNOWN_TOOLS.includes(name.toLowerCase())),
        tools: [
            ...extractWithPatterns(text, PATTERNS.tools),
            ...KNOWN_TOOLS.filter(t => text.toLowerCase().includes(t)),
        ].filter((v, i, a) => a.indexOf(v) === i),
        technologies: extractWithPatterns(text, PATTERNS.technologies),
        commands: extractWithPatterns(text, PATTERNS.commands),
    }
}

/**
 * Merge entities from multiple extractions
 */
export function mergeEntities(a: ExtractedEntities, b: ExtractedEntities): ExtractedEntities {
    return {
        paths: [...new Set([...a.paths, ...b.paths])],
        projects: [...new Set([...a.projects, ...b.projects])],
        people: [...new Set([...a.people, ...b.people])],
        tools: [...new Set([...a.tools, ...b.tools])],
        technologies: [...new Set([...a.technologies, ...b.technologies])],
        commands: [...new Set([...a.commands, ...b.commands])],
    }
}

/**
 * Get entity summary for context injection
 */
export function getEntitySummary(entities: ExtractedEntities): string {
    const parts: string[] = []

    if (entities.projects.length > 0) {
        parts.push(`Projekte: ${entities.projects.slice(0, 5).join(', ')}`)
    }
    if (entities.paths.length > 0) {
        parts.push(`Pfade: ${entities.paths.slice(0, 3).join(', ')}`)
    }
    if (entities.technologies.length > 0) {
        parts.push(`Tech: ${entities.technologies.slice(0, 5).join(', ')}`)
    }

    return parts.length > 0
        ? `\n[Kontext: ${parts.join(' | ')}]`
        : ''
}

// ============================================
// Session Context Manager
// ============================================

const sessionContexts = new Map<string, ConversationContext>()

interface MentionedEntity { id: string; name?: string; excluded: string[]; pending: string[] }
const referents = new Map<string, { recent: MentionedEntity[]; focus?: MentionedEntity }>()
export interface EntityTurnResolution {
    question?: string
    prompt: string
    facts: Array<{ name: string; predicate: string; value: string }>
    correction: boolean
}

/** Conversational identity, not a vision classifier. Only explicit user names
 * bind an image. This transient map never writes memory or learns from model text. */
export function isEntityActionOrFeedback(text: string): boolean {
    return /\b(?:mach|mache|öffne|oeffne|klick|klicke|versuch|versuche|starte|installiere)\b/i.test(text)
        || /^(?:nein[, ]*)?(?:das|dies) ist (?:falsch|nicht richtig|inkorrekt)[.!\s]*$/i.test(text.trim())
}

export function resolveEntityTurn(session: string, text: string, image = false): EntityTurnResolution {
    const state = referents.get(session) || { recent: [] as MentionedEntity[] }
    if (!referents.has(session) && referents.size >= 256) referents.delete(referents.keys().next().value!)
    referents.set(session, state)
    const result: EntityTurnResolution = { prompt: '', facts: [], correction: /nicht ganz|korrektur|sondern|das ist nicht/i.test(text) }
    // Actions/answer feedback are not entity facts. Keep the action and L7 paths.
    if (!image && isEntityActionOrFeedback(text)) return result
    if (image) {
        const fresh: MentionedEntity = { id: `image-${Date.now()}-${state.recent.length}`, excluded: [], pending: [] }
        state.recent.push(fresh); state.focus = fresh
    }
    // A name is supplied by the user, never guessed from a previous photo.
    const named = text.match(/(?:^|[.!\n]\s*)(?:Das|Dies|Hier) ist (?!nicht\b)([\p{Lu}][\p{L}\p{N}_-]{1,50})(?=[\s,.!]|$)/u)
        || text.match(/(?:^|[.!\n]\s*)(?:Mein(?:e|er)?\s+\p{L}+\s+)([\p{Lu}][\p{L}\p{N}_-]{1,50})\s+(?:ist|hat|trägt)\b/u)
    const uncertain = /\?|\b(?:vielleicht|vermutlich|wahrscheinlich|könnte|wäre|eventuell)\b/i.test(text)
    if (named && !uncertain) {
        const name = named[1]
        if (state.focus?.excluded.some(n => n.toLowerCase() === name.toLowerCase())) {
            result.question = `Du hattest gesagt, dass das nicht ${name} ist. Welcher Name ist richtig?`
        } else {
            const entity = state.focus && !state.focus.name ? state.focus
                : state.recent.find(e => e.name?.toLowerCase() === name.toLowerCase())
                    || { id: `name:${name.toLowerCase()}`, name, excluded: [], pending: [] }
            entity.name = name
            if (!state.recent.includes(entity)) state.recent.push(entity)
            state.focus = entity
            for (const value of entity.pending.splice(0)) result.facts.push({ name, predicate: 'beschreibung', value })
        }
    }
    const denied = text.match(/\b(?:[Dd]as|[Dd]ies|[Ee]r|[Ss]ie|[Ee]s) ist nicht ([\p{Lu}][\p{L}\p{N}_-]{1,50})\b/u)
    if (denied && state.focus) {
        state.focus.excluded.push(denied[1])
        // Disowning an identity never modifies the named entity's old facts.
        if (state.focus.name?.toLowerCase() === denied[1].toLowerCase()) state.focus.name = undefined
    }
    const ordinal = text.match(/\b(?:der|die|das) (erste|zweite|dritte|letzte)\b/i)
    if (ordinal) {
        const index = ['erste', 'zweite', 'dritte'].indexOf(ordinal[1].toLowerCase())
        state.focus = index < 0 ? state.recent.at(-1) : state.recent[index]
    }
    const referentialText = named ? text.slice((named.index || 0) + named[0].length) : text
    const referential = referentialText.match(/\b(?:er|sie|es|das|dies|(?:der|die|das)\s+(?:erste|zweite|dritte|letzte))\s+(ist|hat|trägt)\s+(?!nicht\b)([^.!?\n]{2,180})/i)
    const mentionedNames = state.recent.filter(e => e.name && text.split(/[^\p{L}\p{N}_-]+/u).includes(e.name))
    if (referential && !ordinal && new Set(mentionedNames.map(e => e.name)).size > 1) {
        result.question = 'Welchen der genannten Namen meinst du mit diesem Bezug? Ich speichere die Änderung erst nach deiner Zuordnung.'
    }
    const explicit = text.match(/(?:^|[.!\n]\s*)([\p{Lu}][\p{L}\p{N}_-]{1,50})\s+(ist|hat|trägt)\s+(?!nicht\b)([^.!?\n]{2,180})/u)
    if (explicit && !uncertain && !result.question && !['Das', 'Dies', 'Hier', 'Er', 'Sie', 'Es', 'Mein', 'Meine'].includes(explicit[1])) {
        const entity = state.recent.find(e => e.name === explicit[1]) || { id: `name:${explicit[1].toLowerCase()}`, name: explicit[1], excluded: [], pending: [] }
        if (!state.recent.includes(entity)) state.recent.push(entity)
        state.focus = entity
        result.facts.push({ name: explicit[1], predicate: explicit[2].toLowerCase(), value: explicit[3].trim() })
    } else if (referential && !uncertain && !result.question) {
        const value = referential[2].trim()
        if (!state.focus?.name) {
            if (state.focus) state.focus.pending.push(value)
            result.question ||= 'Welches Wesen oder Objekt meinst du? Bitte nenne den Namen, damit ich die Angabe richtig zuordne.'
        } else if (!result.question) {
            result.facts.push({ name: state.focus.name, predicate: referential[1].toLowerCase(), value })
        }
    }
    if (named && state.focus?.name && !uncertain && !result.question) {
        const description = text.slice((named.index || 0) + named[0].length).match(/^,\s*([^.!?\n]{3,180})/)
        if (description) result.facts.push({ name: state.focus.name, predicate: 'beschreibung', value: description[1].trim() })
    }
    if (denied && !state.focus?.name) result.question ||= 'Wie heißt das gezeigte oder zuletzt genannte Wesen bzw. Objekt? Ich ändere die Angaben zur anderen Entität nicht.'
    state.recent = state.recent.slice(-20)
    result.prompt = '\n\n## ENTITÄTENBEZUG\n' + (image ? 'Neues Bild: keine Identität aus älteren Bildern übernehmen. ' : '')
        + `Zuletzt gemeint: ${state.focus?.name || 'noch nicht benannt'}. `
        + `Bekannte Namen in diesem Gespräch: ${state.recent.map(e => e.name).filter(Boolean).join(', ') || 'keine'}. `
        + 'Ordne Merkmale nur der ausdrücklich gemeinten Entität zu. Bei mehreren möglichen Bezügen frage nach; Bildmerkmale allein bestätigen keine Identität. Korrekturen an einer Entität ändern keine andere.'
    return result
}

/** Keep image boundaries in a burst; corrections after each photo settle
 * together before any caller persists the returned facts. */
export function resolveEntityBatch(session: string, turns: Array<{ content: string; image?: unknown }>): EntityTurnResolution {
    const groups: Array<{ content: string; image?: unknown }> = []
    for (const turn of turns) {
        if (turn.image || !groups.length) groups.push({ ...turn })
        else groups[groups.length - 1].content += '\n' + turn.content
    }
    let result: EntityTurnResolution = { prompt: '', facts: [], correction: false }
    for (const group of groups) {
        const next = resolveEntityTurn(session, group.content, Boolean(group.image))
        result = { ...next, facts: [...result.facts, ...next.facts], correction: result.correction || next.correction }
    }
    if (result.question) result.facts = []
    return result
}

/**
 * Update context for a session
 */
export function updateSessionContext(sessionId: string, text: string): ConversationContext {
    const existing = sessionContexts.get(sessionId) || {
        entities: { paths: [], projects: [], people: [], tools: [], technologies: [], commands: [] },
        extractedAt: Date.now(),
    }

    const newEntities = extractEntities(text)
    const merged = mergeEntities(existing.entities, newEntities)

    // Track most recent path/project
    const context: ConversationContext = {
        entities: merged,
        currentProject: newEntities.projects[0] || existing.currentProject,
        lastMentionedPath: newEntities.paths[0] || existing.lastMentionedPath,
        extractedAt: Date.now(),
    }

    sessionContexts.set(sessionId, context)
    return context
}

/**
 * Get context for a session
 */
export function getSessionContext(sessionId: string): ConversationContext | undefined {
    return sessionContexts.get(sessionId)
}

export default {
    extractEntities,
    mergeEntities,
    getEntitySummary,
    updateSessionContext,
    getSessionContext,
}
