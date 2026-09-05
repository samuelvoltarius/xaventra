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
