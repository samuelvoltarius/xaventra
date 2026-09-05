/**
 * Nova Knowledge System
 * 
 * Equivalent to Knowledge Items (KIs).
 * Topic-based persistent knowledge that survives across conversations.
 * 
 * Storage: .nova-data/knowledge/<topic-slug>/
 *   - metadata.json (summary, timestamps, tags)
 *   - content.md (main knowledge content)
 *   - artifacts/ (related files, code snippets, etc.)
 * 
 * Features:
 * - Create/update/delete knowledge items
 * - Search by topic, tags, or full-text
 * - Auto-timestamp and versioning
 * - Cross-reference between items
 */

import {
    existsSync, mkdirSync, readFileSync, writeFileSync,
    readdirSync, rmSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface KnowledgeMetadata {
    id: string
    title: string
    summary: string
    tags: string[]
    createdAt: number
    updatedAt: number
    source: string            // who created it (user, nova, system)
    references: string[]      // IDs of related knowledge items
    accessCount: number
    lastAccessedAt: number
}

export interface KnowledgeItem {
    metadata: KnowledgeMetadata
    content: string
    artifacts: string[]       // list of artifact filenames
}

export interface KnowledgeSearchResult {
    item: KnowledgeMetadata
    relevance: number
    matchType: 'title' | 'tag' | 'content' | 'summary'
}

// ============================================
// Constants
// ============================================

const KNOWLEDGE_DIR = join(process.cwd(), '.nova-data', 'knowledge')

function ensureKnowledgeDir(): void {
    if (!existsSync(KNOWLEDGE_DIR)) {
        mkdirSync(KNOWLEDGE_DIR, { recursive: true })
    }
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[äöü]/g, m => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' }[m] || m))
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
}

// ============================================
// CRUD Operations
// ============================================

export function storeKnowledge(
    title: string,
    content: string,
    options: {
        tags?: string[]
        summary?: string
        source?: string
        references?: string[]
    } = {}
): KnowledgeMetadata {
    ensureKnowledgeDir()

    const id = slugify(title)
    const itemDir = join(KNOWLEDGE_DIR, id)
    const isUpdate = existsSync(itemDir)

    if (!existsSync(itemDir)) {
        mkdirSync(itemDir, { recursive: true })
    }

    // Load existing metadata for updates
    let existingMeta: Partial<KnowledgeMetadata> = {}
    const metaPath = join(itemDir, 'metadata.json')
    if (existsSync(metaPath)) {
        try {
            existingMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
        } catch { /* fresh start */ }
    }

    const now = Date.now()
    const metadata: KnowledgeMetadata = {
        id,
        title,
        summary: options.summary || content.split('\n')[0].slice(0, 200),
        tags: options.tags || existingMeta.tags || [],
        createdAt: existingMeta.createdAt || now,
        updatedAt: now,
        source: options.source || 'nova',
        references: options.references || existingMeta.references || [],
        accessCount: existingMeta.accessCount || 0,
        lastAccessedAt: now,
    }

    // Write metadata
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2))

    // Write content
    writeFileSync(join(itemDir, 'content.md'), content)

    // Create artifacts dir
    const artifactsDir = join(itemDir, 'artifacts')
    if (!existsSync(artifactsDir)) {
        mkdirSync(artifactsDir)
    }

    console.log(`[Knowledge] ${isUpdate ? 'Updated' : 'Created'}: ${title} (${id})`)
    return metadata
}

export function getKnowledge(idOrTitle: string): KnowledgeItem | null {
    ensureKnowledgeDir()

    const id = slugify(idOrTitle)
    const itemDir = join(KNOWLEDGE_DIR, id)

    if (!existsSync(itemDir)) {
        // Try direct ID match
        const directDir = join(KNOWLEDGE_DIR, idOrTitle)
        if (!existsSync(directDir)) return null
        return getKnowledgeById(idOrTitle)
    }

    return getKnowledgeById(id)
}

function getKnowledgeById(id: string): KnowledgeItem | null {
    const itemDir = join(KNOWLEDGE_DIR, id)
    const metaPath = join(itemDir, 'metadata.json')
    const contentPath = join(itemDir, 'content.md')

    if (!existsSync(metaPath)) return null

    try {
        const metadata: KnowledgeMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'))
        const content = existsSync(contentPath) ? readFileSync(contentPath, 'utf-8') : ''

        // Update access stats
        metadata.accessCount++
        metadata.lastAccessedAt = Date.now()
        writeFileSync(metaPath, JSON.stringify(metadata, null, 2))

        // List artifacts
        const artifactsDir = join(itemDir, 'artifacts')
        const artifacts = existsSync(artifactsDir)
            ? readdirSync(artifactsDir)
            : []

        return { metadata, content, artifacts }
    } catch {
        return null
    }
}

export function deleteKnowledge(idOrTitle: string): boolean {
    ensureKnowledgeDir()

    const id = slugify(idOrTitle)
    const itemDir = join(KNOWLEDGE_DIR, id)

    if (!existsSync(itemDir)) {
        // Try direct
        const directDir = join(KNOWLEDGE_DIR, idOrTitle)
        if (!existsSync(directDir)) return false
        rmSync(directDir, { recursive: true, force: true })
        console.log(`[Knowledge] Deleted: ${idOrTitle}`)
        return true
    }

    rmSync(itemDir, { recursive: true, force: true })
    console.log(`[Knowledge] Deleted: ${id}`)
    return true
}

// ============================================
// Search & List
// ============================================

export function listKnowledge(): KnowledgeMetadata[] {
    ensureKnowledgeDir()

    const items: KnowledgeMetadata[] = []

    try {
        const dirs = readdirSync(KNOWLEDGE_DIR)
        for (const dir of dirs) {
            const metaPath = join(KNOWLEDGE_DIR, dir, 'metadata.json')
            if (existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
                    items.push(meta)
                } catch { /* skip corrupted */ }
            }
        }
    } catch { /* dir doesn't exist */ }

    // Sort by last updated
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function searchKnowledge(
    query: string,
    options: { tags?: string[]; limit?: number } = {}
): KnowledgeSearchResult[] {
    ensureKnowledgeDir()

    const { tags, limit = 10 } = options
    const results: KnowledgeSearchResult[] = []
    const queryLower = query.toLowerCase()
    const queryWords = queryLower.split(/\s+/)

    try {
        const dirs = readdirSync(KNOWLEDGE_DIR)

        for (const dir of dirs) {
            const itemDir = join(KNOWLEDGE_DIR, dir)
            const metaPath = join(itemDir, 'metadata.json')
            const contentPath = join(itemDir, 'content.md')

            if (!existsSync(metaPath)) continue

            try {
                const meta: KnowledgeMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'))

                // Tag filter
                if (tags && tags.length > 0) {
                    const hasTag = tags.some(t => meta.tags.includes(t.toLowerCase()))
                    if (!hasTag) continue
                }

                let relevance = 0
                let matchType: KnowledgeSearchResult['matchType'] = 'content'

                // Title match (highest relevance)
                const titleLower = meta.title.toLowerCase()
                if (titleLower.includes(queryLower)) {
                    relevance += 10
                    matchType = 'title'
                } else if (queryWords.some(w => titleLower.includes(w))) {
                    relevance += 5
                    matchType = 'title'
                }

                // Tag match
                const tagMatches = meta.tags.filter(t =>
                    queryWords.some(w => t.toLowerCase().includes(w))
                ).length
                if (tagMatches > 0) {
                    relevance += tagMatches * 3
                    if (matchType !== 'title') matchType = 'tag'
                }

                // Summary match
                const summaryLower = meta.summary.toLowerCase()
                if (summaryLower.includes(queryLower)) {
                    relevance += 4
                    if (matchType !== 'title' && matchType !== 'tag') matchType = 'summary'
                }

                // Content match (read full content only if needed)
                if (relevance === 0 && existsSync(contentPath)) {
                    try {
                        const content = readFileSync(contentPath, 'utf-8').toLowerCase()
                        const contentMatches = queryWords.filter(w => content.includes(w)).length
                        if (contentMatches > 0) {
                            relevance += contentMatches
                            matchType = 'content'
                        }
                    } catch { /* skip */ }
                }

                if (relevance > 0) {
                    // Boost by recency
                    const daysSinceUpdate = (Date.now() - meta.updatedAt) / (1000 * 60 * 60 * 24)
                    const recencyBoost = Math.max(0, 1 - daysSinceUpdate / 90) // decay over 90 days
                    relevance += recencyBoost

                    results.push({ item: meta, relevance, matchType })
                }
            } catch { /* skip corrupted */ }
        }
    } catch { /* no knowledge dir */ }

    // Sort by relevance (descending)
    results.sort((a, b) => b.relevance - a.relevance)
    return results.slice(0, limit)
}

// ============================================
// Knowledge Artifact Management
// ============================================

export function addArtifact(
    knowledgeId: string,
    fileName: string,
    content: string
): boolean {
    const id = slugify(knowledgeId)
    const artifactDir = join(KNOWLEDGE_DIR, id, 'artifacts')

    if (!existsSync(artifactDir)) {
        mkdirSync(artifactDir, { recursive: true })
    }

    writeFileSync(join(artifactDir, fileName), content)
    console.log(`[Knowledge] Artifact added: ${fileName} → ${id}`)
    return true
}

export function getArtifact(knowledgeId: string, fileName: string): string | null {
    const id = slugify(knowledgeId)
    const filePath = join(KNOWLEDGE_DIR, id, 'artifacts', fileName)

    if (!existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
}

// ============================================
// Tool Definitions for Nova Registry
// ============================================

export const knowledgeStoreTool = {
    name: 'knowledge_store',
    description: 'Speichert Wissen zu einem Thema persistent (überlebt Neustarts und Conversations). Nutze das für wichtige Erkenntnisse, Architektur-Entscheidungen, gelöste Probleme, User-Präferenzen.',
    category: 'memory' as const,
    parameters: [
        { name: 'title', type: 'string' as const, description: 'Titel des Wissens-Eintrags', required: true },
        { name: 'content', type: 'string' as const, description: 'Vollständiger Inhalt (Markdown)', required: true },
        { name: 'tags', type: 'string' as const, description: 'Tags (komma-getrennt, z.B. "architektur,nova,deployment")', required: false },
        { name: 'summary', type: 'string' as const, description: 'Kurze Zusammenfassung', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const tags = params.tags
            ? (params.tags as string).split(',').map(t => t.trim().toLowerCase())
            : []

        const meta = storeKnowledge(
            params.title as string,
            params.content as string,
            {
                tags,
                summary: params.summary as string,
                source: 'nova-tool',
            }
        )

        return {
            success: true,
            id: meta.id,
            title: meta.title,
            action: existsSync(join(KNOWLEDGE_DIR, meta.id, 'content.md')) ? 'updated' : 'created',
            message: `✅ Wissen gespeichert: "${meta.title}" (${meta.tags.length} Tags)`,
        }
    },
}

export const knowledgeRecallTool = {
    name: 'knowledge_recall',
    description: 'Sucht in gespeichertem Wissen nach einem Thema. Durchsucht Titel, Tags, Zusammenfassungen und Inhalte. Liefert relevante Wissens-Einträge.',
    category: 'memory' as const,
    parameters: [
        { name: 'query', type: 'string' as const, description: 'Suchbegriff oder Thema', required: true },
        { name: 'tags', type: 'string' as const, description: 'Filter nach Tags (komma-getrennt)', required: false },
        { name: 'limit', type: 'number' as const, description: 'Max Ergebnisse (default: 5)', required: false },
        { name: 'full_content', type: 'boolean' as const, description: 'Vollständigen Inhalt laden (default: nur Metadaten)', required: false },
    ],
    handler: async (params: Record<string, unknown>) => {
        const tags = params.tags
            ? (params.tags as string).split(',').map(t => t.trim().toLowerCase())
            : undefined

        const results = searchKnowledge(
            params.query as string,
            {
                tags,
                limit: (params.limit as number) || 5,
            }
        )

        // Optionally load full content
        if (params.full_content && results.length > 0) {
            return {
                query: params.query,
                results: results.map(r => {
                    const full = getKnowledgeById(r.item.id)
                    return {
                        ...r,
                        content: full?.content?.slice(0, 5000) || '(nicht verfügbar)',
                    }
                }),
            }
        }

        return {
            query: params.query,
            count: results.length,
            results: results.map(r => ({
                id: r.item.id,
                title: r.item.title,
                summary: r.item.summary,
                tags: r.item.tags,
                relevance: Math.round(r.relevance * 10) / 10,
                matchType: r.matchType,
                updatedAt: new Date(r.item.updatedAt).toISOString(),
            })),
        }
    },
}

export const knowledgeListTool = {
    name: 'knowledge_list',
    description: 'Listet alle gespeicherten Wissens-Einträge auf (sortiert nach letztem Update).',
    category: 'memory' as const,
    parameters: [],
    handler: async () => {
        const items = listKnowledge()
        return {
            count: items.length,
            items: items.map(m => ({
                id: m.id,
                title: m.title,
                summary: m.summary.slice(0, 100),
                tags: m.tags,
                updatedAt: new Date(m.updatedAt).toISOString(),
                accessCount: m.accessCount,
            })),
        }
    },
}

export const knowledgeDeleteTool = {
    name: 'knowledge_delete',
    description: 'Löscht einen Wissens-Eintrag.',
    category: 'memory' as const,
    parameters: [
        { name: 'title', type: 'string' as const, description: 'Titel oder ID des Eintrags', required: true },
    ],
    handler: async (params: Record<string, unknown>) => {
        const deleted = deleteKnowledge(params.title as string)
        return {
            success: deleted,
            message: deleted
                ? `🗑️ Wissen gelöscht: "${params.title}"`
                : `❌ Nicht gefunden: "${params.title}"`,
        }
    },
}

export const knowledgeGetTool = {
    name: 'knowledge_get',
    description: 'Lädt einen bestimmten Wissens-Eintrag vollständig (Inhalt + Artifacts).',
    category: 'memory' as const,
    parameters: [
        { name: 'title', type: 'string' as const, description: 'Titel oder ID des Eintrags', required: true },
    ],
    handler: async (params: Record<string, unknown>) => {
        const item = getKnowledge(params.title as string)
        if (!item) {
            return { found: false, error: `Nicht gefunden: "${params.title}"` }
        }
        return {
            found: true,
            id: item.metadata.id,
            title: item.metadata.title,
            tags: item.metadata.tags,
            content: item.content,
            artifacts: item.artifacts,
            updatedAt: new Date(item.metadata.updatedAt).toISOString(),
            accessCount: item.metadata.accessCount,
        }
    },
}

export default {
    storeKnowledge,
    getKnowledge,
    deleteKnowledge,
    listKnowledge,
    searchKnowledge,
    addArtifact,
    getArtifact,
    knowledgeStoreTool,
    knowledgeRecallTool,
    knowledgeListTool,
    knowledgeDeleteTool,
    knowledgeGetTool,
}
