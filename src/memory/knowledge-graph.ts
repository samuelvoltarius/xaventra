/**
 * GraphRAG — JSON-based Knowledge Graph
 *
 * Relationship graph (people, places, devices, projects, preferences).
 *
 * The graph is a projection: memory governance is its only writer
 * (`publish()` for canonical records with subject/predicate/value). Nothing
 * else extracts from conversations into it — sources propose structured
 * facts to governance (auto-observer, nightly distiller, kg_remember), so
 * every edge carries a `governance:<id>` source, scope and lifecycle.
 *
 * Persisted to .nova-data/knowledge-graph.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getMemoryGovernanceCoordinator } from './memory-governance.js'

// ============================================
// Types
// ============================================

export interface GraphNode {
    id: string
    label: string
    type: 'person' | 'project' | 'tool' | 'pet' | 'hardware' | 'concept' | 'place' | 'preference' | 'other'
    properties: Record<string, string>
    createdAt: number
    updatedAt: number
}

export interface GraphEdge {
    id: string
    from: string       // node id
    to: string         // node id
    relation: string   // e.g. "owner_of", "uses", "prefers", "lives_in"
    weight: number     // 0-1 confidence
    source: string     // where this fact came from
    createdAt: number
}

export interface KnowledgeGraph {
    nodes: GraphNode[]
    edges: GraphEdge[]
    version: number
    lastUpdated: number
}

// ============================================
// Storage
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const GRAPH_PATH = join(DATA_DIR, 'knowledge-graph.json')

let graph: KnowledgeGraph = {
    nodes: [],
    edges: [],
    version: 1,
    lastUpdated: Date.now(),
}

function ensureDataDir(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true })
    }
}

let loaded = false

/** Writers and readers load the persisted graph first; a write before the
 * first load would otherwise replace the file with only the new nodes. */
function ensureLoaded(): void {
    if (!loaded) loadGraph()
}

function loadGraph(): void {
    loaded = true
    try {
        if (existsSync(GRAPH_PATH)) {
            let data = readFileSync(GRAPH_PATH, 'utf-8')
            // Strip UTF-8 BOM if present
            if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1)
            const parsed = JSON.parse(data)
            // Guard against null/invalid arrays (can happen from external edits)
            graph = {
                ...parsed,
                nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
                edges: Array.isArray(parsed.edges) ? parsed.edges : [],
            }

            // Purge existing garbage nodes that were added before stopword filter
            const beforeCount = graph.nodes.length
            const validNodeIds = new Set<string>()
            graph.nodes = graph.nodes.filter(n => {
                const valid = isValidLabel(n.label)
                if (valid) validNodeIds.add(n.id)
                return valid
            })
            // Remove orphaned edges
            graph.edges = graph.edges.filter(e =>
                validNodeIds.has(e.from) && validNodeIds.has(e.to)
            )
            const removed = beforeCount - graph.nodes.length
            if (removed > 0) {
                console.log(`[GraphRAG] 🧹 Purged ${removed} invalid nodes`)
                saveGraph()
            }

            console.log(`[GraphRAG] 📊 Loaded: ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
        }
    } catch (err) {
        console.warn(`[GraphRAG] Could not load graph: ${err}`)
    }
}

function saveGraph(): void {
    ensureDataDir()
    graph.lastUpdated = Date.now()
    writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2))
}

// ============================================
// Node Operations
// ============================================

// Stopwords that should NEVER become nodes
const STOPWORDS = new Set([
    // German common words
    'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'auch', 'ist', 'hat', 'nicht',
    'sich', 'noch', 'dann', 'wenn', 'weil', 'dass', 'kann', 'wird', 'war', 'sind', 'haben',
    'werden', 'sein', 'dem', 'den', 'des', 'ihm', 'ihr', 'mir', 'mich', 'dir', 'dich', 'uns',
    'euch', 'hier', 'dort', 'jetzt', 'schon', 'sehr', 'viel', 'mehr', 'nur', 'wie', 'was',
    'wer', 'wen', 'wem', 'alle', 'alles', 'ganz', 'gerade', 'immer', 'nie', 'leider', 'eben',
    'deshalb', 'trotzdem', 'eigentlich', 'natürlich', 'definitiv', 'seltsam', 'merkwürdig',
    'schlimmer', 'schlimm', 'besser', 'gut', 'schlecht', 'richtig', 'falsch', 'genau',
    'nichtmal', 'gar', 'mal', 'halt', 'eben', 'doch', 'also', 'ja', 'nein', 'okay', 'klar',
    'beim', 'vom', 'zum', 'zur', 'für', 'über', 'unter', 'nach', 'vor', 'seit', 'bei',
    'aus', 'von', 'mit', 'ohne', 'gegen', 'durch', 'wegen', 'keine', 'keiner', 'kein',
    'diese', 'dieser', 'dieses', 'mein', 'meine', 'dein', 'deine', 'sein', 'seine',
    'wieder', 'selbst', 'uch', 'chtnis', 'hrung', 'verb', 'verbindung',
    'merkw', 'geklappt', 'gemacht', 'gesagt', 'gefragt', 'geht', 'gibt', 'nehmen',
    'sagen', 'machen', 'fragen', 'wissen', 'denken', 'glauben', 'meinen',
    // English common words
    'the', 'and', 'but', 'not', 'this', 'that', 'with', 'from', 'your', 'have', 'has',
    'was', 'were', 'are', 'been', 'will', 'would', 'could', 'should', 'can', 'may',
    'just', 'also', 'very', 'really', 'actually', 'here', 'there', 'now', 'then',
    'yes', 'true', 'false', 'null', 'undefined', 'error', 'bug', 'problem', 'tool',
])

function isValidLabel(label: string): boolean {
    if (!label || label.length < 3) return false
    if (label.length > 50) return false
    if (STOPWORDS.has(label.toLowerCase())) return false
    // Reject if it's all numbers or purely non-alpha
    if (/^\d+$/.test(label)) return false
    // Reject very short fragments that are likely noise
    if (label.length < 3 && !/^[A-ZÄÖÜ]/.test(label)) return false
    return true
}

function normalizeId(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9äöüß]/g, '_').replace(/_+/g, '_')
}

export function addNode(
    label: string,
    type: GraphNode['type'],
    properties: Record<string, string> = {}
): GraphNode | null {
    ensureLoaded()
    if (!isValidLabel(label)) return null

    // Cap at 500 nodes to prevent unbounded growth
    if (graph.nodes.length >= 500) return null

    const id = normalizeId(label)
    const existing = graph.nodes.find(n => n.id === id)

    if (existing) {
        // Update existing node
        existing.properties = { ...existing.properties, ...properties }
        existing.updatedAt = Date.now()
        saveGraph()
        return existing
    }

    const node: GraphNode = {
        id,
        label,
        type,
        properties,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    }

    graph.nodes.push(node)
    saveGraph()
    console.log(`[GraphRAG] + Node: ${label} (${type})`)
    return node
}

export function getNode(label: string): GraphNode | undefined {
    ensureLoaded()
    const id = normalizeId(label)
    return graph.nodes.find(n => n.id === id)
}

// ============================================
// Edge Operations
// ============================================

export function addEdge(
    fromLabel: string,
    relation: string,
    toLabel: string,
    weight: number = 1.0,
    source: string = 'conversation'
): GraphEdge {
    ensureLoaded()
    const fromId = normalizeId(fromLabel)
    const toId = normalizeId(toLabel)

    // Check for existing edge
    const existing = graph.edges.find(
        e => e.from === fromId && e.to === toId && e.relation === relation
    )
    if (existing) {
        existing.weight = Math.min(1.0, existing.weight + 0.1) // Strengthen
        saveGraph()
        return existing
    }

    // Ensure nodes exist
    if (!graph.nodes.find(n => n.id === fromId)) {
        addNode(fromLabel, 'other')
    }
    if (!graph.nodes.find(n => n.id === toId)) {
        addNode(toLabel, 'other')
    }

    const edge: GraphEdge = {
        id: `${fromId}_${relation}_${toId}`,
        from: fromId,
        to: toId,
        relation,
        weight,
        source,
        createdAt: Date.now(),
    }

    graph.edges.push(edge)
    saveGraph()
    console.log(`[GraphRAG] + Edge: ${fromLabel} —[${relation}]→ ${toLabel}`)
    return edge
}

function governanceIdFromSource(source: string): string | null {
    return source.startsWith('governance:') ? source.slice('governance:'.length) : null
}

function isGovernanceProjectionActive(source: string, allowedScopes?: readonly string[]): boolean {
    const id = governanceIdFromSource(source)
    if (!id) return false
    const record = getMemoryGovernanceCoordinator().get(id)
    const status = record?.status
    if (status !== 'verified' && status !== 'canonical') return false
    return !allowedScopes || allowedScopes.includes(String(record?.scope || ''))
}

export function removeGovernanceProjection(governanceId: string): number {
    ensureLoaded()
    const source = `governance:${governanceId}`
    const beforeEdges = graph.edges.length
    graph.edges = graph.edges.filter(edge => edge.source !== source)

    const referenced = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]))
    const beforeNodes = graph.nodes.length
    graph.nodes = graph.nodes.filter(node =>
        node.properties.governanceId !== governanceId || referenced.has(node.id))
    const removed = (beforeEdges - graph.edges.length) + (beforeNodes - graph.nodes.length)
    if (removed > 0) saveGraph()
    return removed
}

// ============================================
// Query Operations
// ============================================

export function queryRelations(
    label: string,
    allowedScopes?: readonly string[],
): Array<{ relation: string; target: string; weight: number }> {
    const id = normalizeId(label)
    const results: Array<{ relation: string; target: string; weight: number }> = []

    for (const edge of graph.edges) {
        if (!isGovernanceProjectionActive(edge.source, allowedScopes)) continue
        if (edge.from === id) {
            const targetNode = graph.nodes.find(n => n.id === edge.to)
            results.push({
                relation: edge.relation,
                target: targetNode?.label || edge.to,
                weight: edge.weight,
            })
        }
        if (edge.to === id) {
            const sourceNode = graph.nodes.find(n => n.id === edge.from)
            results.push({
                relation: `${edge.relation} (von ${sourceNode?.label || edge.from})`,
                target: sourceNode?.label || edge.from,
                weight: edge.weight,
            })
        }
    }

    return results
}

export function queryByType(type: GraphNode['type']): GraphNode[] {
    ensureLoaded()
    return graph.nodes.filter(n => {
        if (n.type !== type || !n.properties.governanceId) return false
        const status = getMemoryGovernanceCoordinator().get(n.properties.governanceId)?.status
        return status === 'verified' || status === 'canonical'
    })
}

/**
 * @param allowedScopes when given, only nodes/relations whose governance record
 * belongs to one of these scopes are used (principal-bound prompt context).
 */
export function getContextForPrompt(query: string, allowedScopes?: readonly string[]): string {
    ensureLoaded()
    const queryLower = query.toLowerCase()
    const activeNodes = graph.nodes.filter(n => {
        const governanceId = n.properties.governanceId
        if (!governanceId) return false
        const record = getMemoryGovernanceCoordinator().get(governanceId)
        const status = record?.status
        if (status !== 'verified' && status !== 'canonical') return false
        return !allowedScopes || allowedScopes.includes(String(record?.scope || ''))
    })

    // 1. Exact label match (original behavior)
    let relevantNodes = activeNodes.filter(n => {
        return (
        queryLower.includes(n.label.toLowerCase()) ||
        queryLower.includes(n.id)
        )
    })

    // 2. Keyword/token match — catches "Mac" → "MacMini", "Pi" → "Pi5", etc.
    if (relevantNodes.length === 0) {
        const queryTokens = queryLower
            .replace(/[^\w\säöüß]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3)

        relevantNodes = activeNodes.filter(n => {
            const nl = n.label.toLowerCase()
            return queryTokens.some(t =>
                nl.includes(t) || t.includes(nl) ||
                // property values match
                Object.values(n.properties).some(v => v.toLowerCase().includes(t))
            )
        })
    }

    // 3. Preference/instruction nodes always included if query is vague
    const preferenceNodes = activeNodes.filter(n =>
        n.type === 'preference' && relevantNodes.every(r => r.id !== n.id)
    )
    // Only inject preferences if query looks like it needs behavioral context
    const needsBehavior = /\b(wie|antworte?|soll|magst|magst du|bevorzug|erinner|weiß)\b/i.test(query)
    if (needsBehavior) relevantNodes = [...relevantNodes, ...preferenceNodes.slice(0, 5)]

    if (relevantNodes.length === 0) return ''

    const facts: string[] = []
    for (const node of relevantNodes.slice(0, 8)) {  // cap at 8 nodes
        const relations = queryRelations(node.label, allowedScopes)
        if (relations.length > 0) {
            const props = Object.entries(node.properties).map(([k, v]) => `${k}=${v}`).join(', ')
            facts.push(`${node.label} (${node.type}${props ? ': ' + props : ''}):`)
            for (const r of relations.slice(0, 5)) {
                facts.push(`  → ${r.relation}: ${r.target}`)
            }
        } else if (Object.keys(node.properties).length > 0) {
            const props = Object.entries(node.properties).map(([k, v]) => `${k}=${v}`).join(', ')
            facts.push(`${node.label}: ${props}`)
        }
    }

    return facts.length > 0 ? `\n[Knowledge Graph]\n${facts.join('\n')}` : ''
}

/**
 * Keyword search across all graph nodes and edges — no LLM needed.
 * Returns a formatted context string.
 * @param allowedScopes when given, only nodes/relations whose governance record
 * belongs to one of these scopes are searched (principal-bound, INT-10).
 * Omit only for the owner.
 */
export function searchGraph(query: string, limit = 6, allowedScopes?: readonly string[]): string {
    ensureLoaded()
    const tokens = query.toLowerCase()
        .replace(/[^\w\säöüß]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3)
    if (tokens.length === 0) return ''

    // Score each node
    const scored = graph.nodes.filter(node => {
        const id = node.properties.governanceId
        if (!id) return false
        const record = getMemoryGovernanceCoordinator().get(id)
        const status = record?.status
        if (status !== 'verified' && status !== 'canonical') return false
        return !allowedScopes || allowedScopes.includes(String(record?.scope || ''))
    }).map(node => {
        let score = 0
        const nl = node.label.toLowerCase()
        const propsText = Object.values(node.properties).join(' ').toLowerCase()

        for (const t of tokens) {
            if (nl === t) score += 3
            else if (nl.includes(t) || t.includes(nl)) score += 1.5
            if (propsText.includes(t)) score += 1
        }

        // Boost recently updated nodes
        const ageDays = (Date.now() - node.updatedAt) / 86_400_000
        score *= Math.max(0.5, 1 - ageDays / 60)

        return { node, score }
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)

    if (scored.length === 0) return ''

    const lines = [`[Graph-Suche: "${query}"]`]
    for (const { node } of scored) {
        const rels = queryRelations(node.label, allowedScopes)
        const relStr = rels.slice(0, 3).map(r => `${r.relation}→${r.target}`).join(', ')
        lines.push(`- ${node.label} (${node.type})${relStr ? ': ' + relStr : ''}`)
    }
    return lines.join('\n')
}

// ============================================
// Stats
// ============================================

export function getStats(): { nodes: number; edges: number; types: Record<string, number> } {
    ensureLoaded()
    const types: Record<string, number> = {}
    for (const node of graph.nodes) {
        types[node.type] = (types[node.type] || 0) + 1
    }
    return { nodes: graph.nodes.length, edges: graph.edges.length, types }
}

export function getFullGraph(): KnowledgeGraph {
    ensureLoaded()
    return { ...graph }
}

/** /graph: counts of the governed graph. */
export function formatGraphStats(): string {
    const stats = getStats()
    const types = Object.entries(stats.types).map(([type, count]) => `${type}(${count})`).join(', ')
    return [
        '🕸️ Knowledge Graph',
        `Knoten: ${stats.nodes} · Kanten: ${stats.edges}`,
        `Typen: ${types || 'keine'}`,
        'Quelle: Memory-Governance (nur kanonische Fakten mit Subjekt/Beziehung/Wert)',
    ].join('\n')
}

// ============================================
// Init
// ============================================

export function initKnowledgeGraph(): void {
    loadGraph()
}

export default {
    initKnowledgeGraph,
    addNode,
    addEdge,
    getNode,
    queryRelations,
    queryByType,
    getContextForPrompt,
    getStats,
    formatGraphStats,
    getFullGraph,
}
