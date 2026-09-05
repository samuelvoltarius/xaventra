/**
 * Knowledge Graph — arscontexta-inspired auto-knowledge extraction
 *
 * Automatically builds a knowledge graph from conversations:
 * - Extracts entities, claims, decisions from messages
 * - Links related concepts via wiki-style connections
 * - Maintains Maps of Content (MOCs) at different levels
 * - Persists as plain markdown files (no database, no cloud)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const GRAPH_DIR = join(process.cwd(), '.nova-data', 'knowledge-graph')

// ============================================
// Types
// ============================================

export type NodeType = 'fact' | 'claim' | 'decision' | 'entity' | 'pattern' | 'tool' | 'project' | 'person'

export interface KnowledgeNode {
    id: string
    type: NodeType
    title: string
    content: string
    links: string[]           // IDs of linked nodes
    tags: string[]
    confidence: number        // 0-1
    source: 'conversation' | 'dream' | 'learning' | 'manual'
    createdAt: number
    updatedAt: number
    accessCount: number
}

interface KnowledgeGraphState {
    nodes: Record<string, KnowledgeNode>
    mocs: Record<string, string[]>  // Map of Content → node IDs
    stats: {
        totalNodes: number
        totalLinks: number
        totalExtractions: number
    }
}

// ============================================
// State
// ============================================

let graph: KnowledgeGraphState = {
    nodes: {},
    mocs: {},
    stats: { totalNodes: 0, totalLinks: 0, totalExtractions: 0 },
}

let initialized = false

function ensureDir(): void {
    if (!existsSync(GRAPH_DIR)) mkdirSync(GRAPH_DIR, { recursive: true })
}

export function initKnowledgeGraph(): void {
    if (initialized) return
    ensureDir()

    const path = join(GRAPH_DIR, 'graph.json')
    if (existsSync(path)) {
        try { graph = JSON.parse(readFileSync(path, 'utf-8')) } catch { }
    }

    initialized = true
    console.log(`[KnowledgeGraph] ✅ Loaded ${Object.keys(graph.nodes).length} nodes`)
}

function save(): void {
    writeFileSync(join(GRAPH_DIR, 'graph.json'), JSON.stringify(graph, null, 2))
}

// ============================================
// Node Operations
// ============================================

export function addNode(
    type: NodeType,
    title: string,
    content: string,
    options: {
        links?: string[]
        tags?: string[]
        confidence?: number
        source?: KnowledgeNode['source']
    } = {}
): KnowledgeNode {
    initKnowledgeGraph()

    // Check for existing node with same title
    const existing = Object.values(graph.nodes).find(n =>
        n.title.toLowerCase() === title.toLowerCase() && n.type === type
    )

    if (existing) {
        // Update existing
        existing.content = content
        existing.updatedAt = Date.now()
        existing.accessCount++
        if (options.links) {
            existing.links = [...new Set([...existing.links, ...options.links])]
        }
        if (options.tags) {
            existing.tags = [...new Set([...existing.tags, ...options.tags])]
        }
        save()
        return existing
    }

    const id = `kn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const node: KnowledgeNode = {
        id,
        type,
        title,
        content,
        links: options.links || [],
        tags: options.tags || [],
        confidence: options.confidence ?? 0.8,
        source: options.source || 'conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 0,
    }

    graph.nodes[id] = node
    graph.stats.totalNodes++
    graph.stats.totalLinks += node.links.length

    // Auto-link to related nodes
    autoLink(node)

    // Update MOCs
    updateMOC(node)

    save()
    return node
}

/**
 * Auto-detect links between nodes based on content overlap
 */
function autoLink(node: KnowledgeNode): void {
    const words = new Set(
        `${node.title} ${node.content}`.toLowerCase().split(/\s+/)
            .filter(w => w.length > 3)
    )

    for (const [id, other] of Object.entries(graph.nodes)) {
        if (id === node.id) continue

        const otherWords = `${other.title} ${other.content}`.toLowerCase()
        let overlap = 0
        for (const word of words) {
            if (otherWords.includes(word)) overlap++
        }

        // Link if significant overlap
        if (overlap > 3 && !node.links.includes(id)) {
            node.links.push(id)
            if (!other.links.includes(node.id)) {
                other.links.push(node.id)
            }
            graph.stats.totalLinks++
        }
    }
}

/**
 * Update Maps of Content — group nodes by type/tag
 */
function updateMOC(node: KnowledgeNode): void {
    // Type-based MOC
    const typeMoc = `moc-${node.type}`
    if (!graph.mocs[typeMoc]) graph.mocs[typeMoc] = []
    if (!graph.mocs[typeMoc].includes(node.id)) {
        graph.mocs[typeMoc].push(node.id)
    }

    // Tag-based MOCs
    for (const tag of node.tags) {
        const tagMoc = `moc-tag-${tag}`
        if (!graph.mocs[tagMoc]) graph.mocs[tagMoc] = []
        if (!graph.mocs[tagMoc].includes(node.id)) {
            graph.mocs[tagMoc].push(node.id)
        }
    }
}

// ============================================
// Extraction — parse conversations for knowledge
// ============================================

/**
 * Extract knowledge from a conversation message
 * Called after each message processing
 */
export function extractFromMessage(
    userMessage: string,
    novaResponse: string,
    context?: { channel: string; user: string }
): void {
    initKnowledgeGraph()
    graph.stats.totalExtractions++

    const combined = `${userMessage}\n${novaResponse}`

    // Extract entities (simple pattern matching)
    const entities = extractEntities(combined)
    for (const entity of entities) {
        addNode('entity', entity.name, entity.context, {
            tags: entity.tags,
            source: 'conversation',
        })
    }

    // Extract decisions (patterns like "wir machen", "I'll use", "let's go with")
    const decisions = extractDecisions(combined)
    for (const decision of decisions) {
        addNode('decision', decision, combined.slice(0, 200), {
            tags: ['auto-extracted'],
            source: 'conversation',
        })
    }

    // Extract tool/tech mentions
    const tools = extractTools(combined)
    for (const tool of tools) {
        addNode('tool', tool, `Erwähnt in Konversation`, {
            tags: ['auto-extracted'],
            source: 'conversation',
        })
    }

    if (entities.length + decisions.length + tools.length > 0) {
        save()
    }
}

function extractEntities(text: string): Array<{ name: string; context: string; tags: string[] }> {
    const entities: Array<{ name: string; context: string; tags: string[] }> = []

    // Project names (capitalized multi-word)
    const projectPattern = /(?:Projekt|project|app|system)\s+["']?([A-Z][a-zA-Z\s-]+)["']?/gi
    let match: RegExpExecArray | null
    while ((match = projectPattern.exec(text)) !== null) {
        entities.push({
            name: match[1].trim(),
            context: text.slice(Math.max(0, match.index - 50), match.index + 100),
            tags: ['project'],
        })
    }

    // Person names
    const personPattern = /(?:@|User|von|by|für)\s+([A-Z][a-z]+ [A-Z][a-z]+)/g
    while ((match = personPattern.exec(text)) !== null) {
        entities.push({
            name: match[1],
            context: text.slice(Math.max(0, match.index - 50), match.index + 100),
            tags: ['person'],
        })
    }

    return entities
}

function extractDecisions(text: string): string[] {
    const decisions: string[] = []
    const patterns = [
        /(?:wir nehmen|wir machen|wir verwenden|entscheidung:)\s+(.{10,80})/gi,
        /(?:I'll use|let's go with|decision:)\s+(.{10,80})/gi,
        /(?:✅|→|beschlossen:)\s+(.{10,80})/gi,
    ]

    for (const pattern of patterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(text)) !== null) {
            const decision = match[1].trim().replace(/[.\n].*/, '')
            if (decision.length > 10) decisions.push(decision)
        }
    }

    return decisions.slice(0, 3) // Max 3 per message
}

function extractTools(text: string): string[] {
    const toolPatterns = /\b(Docker|Kubernetes|Redis|PostgreSQL|MongoDB|Prisma|NestJS|Next\.js|React|Vue|Tailwind|Supabase|Stripe|Whisper|Ollama|LangChain)\b/gi
    const tools = new Set<string>()

    let match: RegExpExecArray | null
    while ((match = toolPatterns.exec(text)) !== null) {
        tools.add(match[1])
    }

    return [...tools]
}

// ============================================
// Query
// ============================================

export function searchGraph(query: string, limit: number = 10): KnowledgeNode[] {
    initKnowledgeGraph()

    const queryLower = query.toLowerCase()
    const words = queryLower.split(/\s+/)

    return Object.values(graph.nodes)
        .map(node => {
            let score = 0
            const text = `${node.title} ${node.content} ${node.tags.join(' ')}`.toLowerCase()
            for (const word of words) {
                if (node.title.toLowerCase().includes(word)) score += 10
                if (text.includes(word)) score += 2
            }
            score += node.confidence * 3
            score += Math.min(node.links.length, 5)
            return { node, score }
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.node)
}

export function getGraphStats(): string {
    initKnowledgeGraph()

    const byType: Record<string, number> = {}
    for (const node of Object.values(graph.nodes)) {
        byType[node.type] = (byType[node.type] || 0) + 1
    }

    return `🕸️ **Knowledge Graph**
Nodes: ${graph.stats.totalNodes}
Links: ${graph.stats.totalLinks}
Extractions: ${graph.stats.totalExtractions}
Types: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(', ')}
MOCs: ${Object.keys(graph.mocs).length}`
}

/**
 * Get graph context for system prompt (compact)
 */
export function getGraphContextForPrompt(query: string): string {
    const results = searchGraph(query, 5)
    if (results.length === 0) return ''

    const lines = results.map(n =>
        `[${n.type}] ${n.title} (${n.links.length} links, conf: ${n.confidence})`
    )

    return `\n\n## KNOWLEDGE GRAPH (${Object.keys(graph.nodes).length} nodes)\n${lines.join('\n')}`
}
