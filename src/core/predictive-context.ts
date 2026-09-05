/**
 * Predictive Context Pre-loading
 * 
 * Analyzes incoming messages BEFORE the LLM call to pre-load
 * relevant context (memory, graph nodes, SSH hosts, tool params).
 * 
 * This reduces latency by starting context fetches in parallel
 * with other pipeline steps (Soul 2.0, Journal, etc.)
 */

// ============================================
// Types
// ============================================

interface PredictedContext {
    graphNodes?: string[]        // Relevant knowledge graph topics
    memoryQueries?: string[]     // Vector memory search queries
    sshHosts?: string[]          // SSH hosts likely needed
    tools?: string[]             // Tools likely to be called
    filePatterns?: string[]      // Files likely referenced
    webSearches?: string[]       // Pre-emptive web searches
}

interface PreloadedContext {
    memories: string[]
    graphFacts: string[]
    sshHostInfo: string[]
    predictedTools: string[]
    preloadTimeMs: number
}

// ============================================
// Pattern Detection
// ============================================

const TOOL_PATTERNS: Record<string, RegExp[]> = {
    ssh_command: [
        /ssh|server|pi|raspberry|hetzner|remote|nas|deploy/i,
        /starte?|neustart|restart|reboot|shutdown/i,
    ],
    run_command: [
        /terminal|command|cmd|powershell|bash|ausführ|starte/i,
        /install|npm|git|docker|pip|choco/i,
    ],
    web_search: [
        /such|google|find|recherchier|was ist|wie geht/i,
        /warum|wieso|woher|erklär/i,
    ],
    read_file: [
        /lies|zeig|öffne|datei|file|config|log/i,
        /was steht in|inhalt von|schau in/i,
    ],
    write_file: [
        /schreib|erstell|änder|edit|modifizier/i,
        /füge? hinzu|aktualisier|update/i,
    ],
    take_screenshot: [
        /screenshot|bildschirm|screen|zeig mir/i,
    ],
}

const SSH_HOST_PATTERNS: Record<string, RegExp> = {
    'pi': /pi\s?[45]?|raspberry|raspb/i,
    'hetzner': /hetzner|vps|cloud.*server/i,
    'nas': /nas|synology|qnap|storage/i,
}

const TOPIC_EXTRACTORS: RegExp[] = [
    /(?:über|about|zu|wegen)\s+(\w+(?:\s+\w+)?)/i,
    /was (?:ist|sind|war|waren)\s+(\w+(?:\s+\w+)?)/i,
    /(?:erinnerst|weißt|kennst)\s+(?:du\s+)?(?:dich\s+)?(?:an\s+)?(\w+(?:\s+\w+)?)/i,
]

// ============================================
// Core Functions
// ============================================

/**
 * Predict what context will be needed for a message.
 * This is fast (regex-only, no LLM calls).
 */
export function predictContext(message: string): PredictedContext {
    const ctx: PredictedContext = {}

    // Predict tools
    const predictedTools: string[] = []
    for (const [toolName, patterns] of Object.entries(TOOL_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(message)) {
                predictedTools.push(toolName)
                break
            }
        }
    }
    if (predictedTools.length > 0) ctx.tools = predictedTools

    // Predict SSH hosts
    const sshHosts: string[] = []
    for (const [hostAlias, pattern] of Object.entries(SSH_HOST_PATTERNS)) {
        if (pattern.test(message)) {
            sshHosts.push(hostAlias)
        }
    }
    if (sshHosts.length > 0) ctx.sshHosts = sshHosts

    // Extract topics for graph/memory lookup
    const topics: string[] = []
    for (const extractor of TOPIC_EXTRACTORS) {
        const match = message.match(extractor)
        if (match?.[1]) {
            topics.push(match[1].trim())
        }
    }

    // Also use key nouns from the message (words > 4 chars, not common)
    const STOP_WORDS = new Set([
        'nicht', 'haben', 'einen', 'einer', 'diese', 'dieser',
        'dieses', 'können', 'werden', 'sollen', 'müssen',
        'bitte', 'kannst', 'könntest', 'würdest', 'mache',
        'machst', 'the', 'and', 'for', 'with', 'that', 'this',
    ])

    const words = message.split(/\s+/)
        .map(w => w.replace(/[^a-zA-ZäöüÄÖÜß]/g, ''))
        .filter(w => w.length > 4 && !STOP_WORDS.has(w.toLowerCase()))

    topics.push(...words.slice(0, 3))

    if (topics.length > 0) {
        ctx.graphNodes = [...new Set(topics)]
        ctx.memoryQueries = [...new Set(topics)]
    }

    return ctx
}

/**
 * Pre-load context in parallel based on predictions.
 * Returns whatever loaded successfully within the time budget.
 */
export async function preloadContext(
    message: string,
    timeBudgetMs: number = 2000
): Promise<PreloadedContext> {
    const start = Date.now()
    const predictions = predictContext(message)

    const result: PreloadedContext = {
        memories: [],
        graphFacts: [],
        sshHostInfo: [],
        predictedTools: predictions.tools || [],
        preloadTimeMs: 0,
    }

    // Nothing to preload
    if (!predictions.graphNodes?.length && !predictions.memoryQueries?.length && !predictions.sshHosts?.length) {
        result.preloadTimeMs = Date.now() - start
        return result
    }

    const tasks: Promise<void>[] = []

    // Pre-load vector memory
    if (predictions.memoryQueries?.length) {
        tasks.push(
            (async () => {
                try {
                    const lanceMemory = (await import('../memory/lancedb-memory.js')).default
                    for (const query of predictions.memoryQueries!.slice(0, 2)) {
                        const results = await lanceMemory.recall(query, 3)
                        if (results?.length) {
                            result.memories.push(
                                ...results.map((r: any) => r.entry?.content || String(r)).slice(0, 2)
                            )
                        }
                    }
                } catch { /* memory not available */ }
            })()
        )
    }

    // Pre-load graph facts
    if (predictions.graphNodes?.length) {
        tasks.push(
            (async () => {
                try {
                    const knowledgeGraph = (await import('../memory/knowledge-graph.js')).default
                    for (const topic of predictions.graphNodes!.slice(0, 3)) {
                        const contextStr = knowledgeGraph.getContextForPrompt(topic)
                        if (contextStr && contextStr.length > 10) {
                            result.graphFacts.push(contextStr.slice(0, 300))
                        }
                    }
                } catch { /* graph not available */ }
            })()
        )
    }

    // Pre-load SSH host info
    if (predictions.sshHosts?.length) {
        tasks.push(
            (async () => {
                try {
                    const { existsSync, readFileSync } = await import('node:fs')
                    const { join } = await import('node:path')
                    const hostsFile = join(process.cwd(), '.nova-data', 'ssh-hosts.json')
                    if (existsSync(hostsFile)) {
                        const hosts = JSON.parse(readFileSync(hostsFile, 'utf-8'))
                        for (const alias of predictions.sshHosts!) {
                            const host = hosts[alias]
                            if (host) {
                                result.sshHostInfo.push(`${alias}: ${host.user}@${host.host}:${host.port || 22}`)
                            }
                        }
                    }
                } catch { /* hosts not available */ }
            })()
        )
    }

    // Race all tasks against time budget
    await Promise.race([
        Promise.allSettled(tasks),
        new Promise<void>(resolve => setTimeout(resolve, timeBudgetMs)),
    ])

    result.preloadTimeMs = Date.now() - start

    // Deduplicate
    result.memories = [...new Set(result.memories)]
    result.graphFacts = [...new Set(result.graphFacts)]

    if (result.memories.length || result.graphFacts.length || result.sshHostInfo.length) {
        console.log(`[PredictiveContext] Pre-loaded: ${result.memories.length} memories, ${result.graphFacts.length} graph facts, ${result.sshHostInfo.length} SSH hosts in ${result.preloadTimeMs}ms`)
    }

    return result
}

/**
 * Build a context injection string from preloaded results.
 */
export function buildPreloadedPrompt(ctx: PreloadedContext): string | null {
    const parts: string[] = []

    if (ctx.memories.length > 0) {
        parts.push(`**Relevante Erinnerungen:**\n${ctx.memories.map(m => `- ${m.slice(0, 200)}`).join('\n')}`)
    }

    if (ctx.graphFacts.length > 0) {
        parts.push(`**Relevante Fakten:**\n${ctx.graphFacts.map(f => `- ${f.slice(0, 200)}`).join('\n')}`)
    }

    if (ctx.sshHostInfo.length > 0) {
        parts.push(`**SSH Hosts (vorab geladen):**\n${ctx.sshHostInfo.join('\n')}`)
    }

    if (ctx.predictedTools.length > 0) {
        parts.push(`**Voraussichtlich benötigte Tools:** ${ctx.predictedTools.join(', ')}`)
    }

    if (parts.length === 0) return null

    return `## Predictive Context (Pre-loaded)\n${parts.join('\n\n')}`
}
