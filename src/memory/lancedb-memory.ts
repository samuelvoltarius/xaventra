/**
 * LanceDB Long-Term Memory
 * 
 * Selbst-initialisierende Vektor-Datenbank für perfektes Langzeitgedächtnis.
 * Initialisiert sich automatisch beim ersten Start.
 */

import lancedb from '@lancedb/lancedb'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getEmbedding as getMultiProviderEmbedding } from './embedding-providers.js'
import { hybridRerankResults } from './hybrid-search.js'
import { expandQueryRuleBased } from './query-expansion.js'
import { redactSecrets } from '../security/secret-redaction.js'

// ============================================
// Types
// ============================================

export interface MemoryEntry {
    id: string
    content: string
    embedding: number[]
    type: 'conversation' | 'learning' | 'fact' | 'code' | 'error_solution'
    source: string
    timestamp: number
    metadata: string  // JSON-serialized — LanceDB needs fixed schema
}

export interface SearchResult {
    entry: MemoryEntry
    score: number
}

/** Principal-bound read access for recall. */
export interface RecallAccess {
    /** Allowed `metadata.scope` values, e.g. `user:<principal>` and `global`. */
    scopes: string[]
    /** Legacy rows without a scope are visible only to the owner. */
    includeUnscoped?: boolean
}

/**
 * True when a stored row may be shown to a principal with this access. Rows
 * carry their scope in metadata.scope (`user:X` / `global`); rows without one
 * predate scoping and are treated as owner data.
 */
export function isRecallAllowed(metadata: Record<string, unknown>, access: RecallAccess): boolean {
    const scope = typeof metadata?.scope === 'string' ? metadata.scope.trim() : ''
    if (!scope) return access.includeUnscoped === true
    return access.scopes.includes(scope)
}

/** Fail-closed: only explicitly global entries opted in with meshShare leave this node. */
export function isMeshShareable(metadata: Record<string, unknown> | null | undefined): boolean {
    return metadata?.scope === 'global' && metadata?.meshShare === true
}

// ============================================
// Configuration
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const DB_PATH = join(DATA_DIR, 'lancedb')
const TABLE_NAME = 'memories'
const EMBEDDING_DIM = 768  // Embedding dimension

// ============================================
// State
// ============================================

let db: any = null
let table: any = null
let isInitialized = false

// Embedding cache — avoid redundant API calls for identical content
const embeddingCache = new Map<string, number[]>()
const EMBEDDING_CACHE_MAX = 500

// ============================================
// Embedding Function (Multi-Provider)
// ============================================

/**
 * Generiert Embeddings via Multi-Provider System
 * Priorität: Ollama → OpenAI → OpenRouter → Hash
 */
async function getEmbedding(text: string): Promise<number[]> {
    const cacheKey = text.slice(0, 200) // Use first 200 chars as cache key
    if (embeddingCache.has(cacheKey)) {
        return embeddingCache.get(cacheKey)!
    }
    const embedding = await getMultiProviderEmbedding(text, { dimension: EMBEDDING_DIM })
    // Evict oldest entry if cache is full
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const firstKey = embeddingCache.keys().next().value
        if (firstKey !== undefined) embeddingCache.delete(firstKey)
    }
    embeddingCache.set(cacheKey, embedding)
    return embedding
}

// ============================================
// Auto-Initialization
// ============================================

/**
 * Initialisiert LanceDB automatisch beim ersten Aufruf
 */
export async function ensureInitialized(): Promise<boolean> {
    if (isInitialized) return true

    try {
        console.log('[LanceDB] 🚀 Auto-Initialisierung gestartet...')

        // Erstelle Datenverzeichnis
        if (!existsSync(DATA_DIR)) {
            mkdirSync(DATA_DIR, { recursive: true })
            console.log(`[LanceDB] Verzeichnis erstellt: ${DATA_DIR}`)
        }

        // Verbinde zur Datenbank (erstellt sie falls nicht vorhanden)
        db = await lancedb.connect(DB_PATH)
        console.log(`[LanceDB] Datenbank verbunden: ${DB_PATH}`)

        // Prüfe ob Tabelle existiert
        const tables = await db.tableNames()

        if (tables.includes(TABLE_NAME)) {
            table = await db.openTable(TABLE_NAME)
            const count = await table.countRows()
            console.log(`[LanceDB] ✅ Tabelle geladen: ${count} Einträge`)
        } else {
            // Erstelle neue Tabelle mit Beispiel-Eintrag
            const initialEntry: MemoryEntry = {
                id: 'init_' + Date.now(),
                content: 'Nova Langzeitgedächtnis initialisiert',
                embedding: await getEmbedding('Nova Langzeitgedächtnis initialisiert'),
                type: 'fact',
                source: 'system',
                timestamp: Date.now(),
                metadata: JSON.stringify({ version: '1.0' }),
            }

            table = await db.createTable(TABLE_NAME, [initialEntry])
            console.log('[LanceDB] ✅ Neue Tabelle erstellt')
        }

        isInitialized = true

        // Speichere Status
        writeFileSync(
            join(DATA_DIR, 'lancedb-status.json'),
            JSON.stringify({
                initialized: true,
                timestamp: Date.now(),
                path: DB_PATH,
            }, null, 2)
        )

        console.log('[LanceDB] 🧠 Langzeitgedächtnis bereit!')
        return true

    } catch (err) {
        console.error(`[LanceDB] ❌ Initialisierung fehlgeschlagen: ${err}`)
        return false
    }
}

// ============================================
// Memory Operations
// ============================================

/**
 * Speichert einen neuen Eintrag im Langzeitgedächtnis
 */
export async function remember(
    content: string,
    type: MemoryEntry['type'] = 'fact',
    source: string = 'nova',
    metadata: Record<string, any> = {}
): Promise<string | null> {
    // Input validation
    if (!content || typeof content !== 'string') {
        console.warn('[LanceDB] remember called with invalid content')
        return null
    }

    if (!await ensureInitialized()) return null

    try {
        const entry: MemoryEntry = {
            id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            embedding: await getEmbedding(content),
            type,
            source,
            timestamp: Date.now(),
            metadata: JSON.stringify(metadata),
        }

        await table.add([entry])
        console.log(`[LanceDB] 📝 Gespeichert: "${content.slice(0, 50)}..."`)

        // Mesh copies carry no scope and cannot be forgotten remotely yet
        // (mesh-memory-sync has no scope field and no delete/tombstone). So a
        // private or unscoped entry never leaves this node; only entries that
        // are explicitly global and marked for sharing are sent, redacted.
        if (isMeshShareable(metadata)) {
            try {
                const { shareMemory } = await import('../mesh/mesh-memory-sync.js')
                shareMemory(redactSecrets(content), type as any, source, 'global').catch(() => { })
            } catch { /* mesh not available */ }
        }

        return entry.id
    } catch (err) {
        console.error(`[LanceDB] Speichern fehlgeschlagen: ${err}`)
        return null
    }
}

/**
 * Enhanced recall with full pipeline:
 * Query Expansion → Vector Search → Hybrid Re-rank (keyword+decay+MMR)
 */
export async function recall(
    query: string,
    limit: number = 5,
    typeFilter?: MemoryEntry['type'],
    access?: RecallAccess,
): Promise<SearchResult[]> {
    // Input validation
    if (!query || typeof query !== 'string') {
        console.warn('[LanceDB] recall called with invalid query')
        return []
    }

    if (access && access.scopes.length === 0 && access.includeUnscoped !== true) return []
    if (!await ensureInitialized()) return []

    try {
        // 1) Query expansion (rule-based, fast)
        const expandedQuery = expandQueryRuleBased(query)

        // 2) Get embedding for expanded query
        const queryEmbedding = await getEmbedding(expandedQuery)

        // 3) Fetch more candidates than needed (for re-ranking)
        // Scope filtering happens after the vector search, so over-fetch a bit
        // more when the caller is principal-bound.
        const candidateCount = access ? Math.max(limit * 6, 30) : Math.max(limit * 3, 15)
        let search = table.search(queryEmbedding).limit(candidateCount)

        const VALID_TYPES = new Set(['conversation', 'learning', 'fact', 'code', 'error_solution'])
        if (typeFilter && VALID_TYPES.has(typeFilter)) {
            search = search.where(`type = '${typeFilter}'`)
        }

        const rawResults = await search.toArray()

        // 4) Map to standard format
        const mapped = rawResults.map((r: any) => ({
            id: r.id,
            content: r.content,
            score: 1 - (r._distance || 0),
            timestamp: r.timestamp || 0,
            type: r.type,
            source: r.source,
            metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata || {}),
        }))

        // 5) Governance filter: expired, rejected and superseded projections
        // must never re-enter the prompt merely because their vector is close.
        let governed = mapped
        try {
            const { getMemoryGovernanceCoordinator } = await import('./memory-governance.js')
            const coordinator = getMemoryGovernanceCoordinator()
            const now = Date.now()
            governed = mapped.filter((entry: any) => {
                let metadata: any = {}
                try { metadata = JSON.parse(entry.metadata || '{}') } catch { /* legacy row */ }
                if (metadata.expiresAt && Number(metadata.expiresAt) <= now) return false
                if (!metadata.governanceId) return true // legacy entries remain compatible
                return coordinator.isRecallable(String(metadata.governanceId), now)
            })
        } catch { /* governance catalog is optional for legacy databases */ }

        // 5b) Principal scope filter (fail-closed, outside the optional
        // governance try): another principal's rows never reach the prompt.
        if (access) {
            governed = governed.filter((entry: any) => {
                let metadata: Record<string, unknown> = {}
                try { metadata = JSON.parse(entry.metadata || '{}') } catch { /* unscoped legacy row */ }
                return isRecallAllowed(metadata, access)
            })
        }

        // 6) Hybrid re-rank: keyword scoring + temporal decay + MMR diversity
        const reranked = hybridRerankResults(governed, query)

        // 7) Take top results and format
        return reranked.slice(0, limit).map(r => ({
            entry: {
                id: r.id,
                content: r.content,
                embedding: [],  // Don't return embeddings for efficiency
                type: (r.type || 'fact') as MemoryEntry['type'],
                source: r.source || 'unknown',
                timestamp: r.timestamp,
                metadata: r.metadata || '{}',
            },
            score: r.score,
        }))
    } catch (err) {
        console.error(`[LanceDB] Suche fehlgeschlagen: ${err}`)
        return []
    }
}

/**
 * Sucht nach exaktem Match (für Duplikat-Vermeidung)
 */
export async function exists(content: string): Promise<boolean> {
    const results = await recall(content, 1)
    return results.length > 0 && results[0].score > 0.95
}

/**
 * Löscht einen Eintrag
 */
export async function forget(id: string): Promise<boolean> {
    if (!id || typeof id !== 'string' || id.length > 200) {
        console.warn('[LanceDB] forget called with invalid id')
        return false
    }

    if (!await ensureInitialized()) return false

    try {
        const safeId = id.replace(/['"\\;]/g, '')
        // A mesh copy is keyed by its redacted content, so read the row first.
        let row: { content: string; metadata: Record<string, unknown> } | null = null
        try {
            const rows = await table.query().where(`id = '${safeId}'`).limit(1).toArray()
            if (rows[0]) {
                let metadata: Record<string, unknown> = {}
                try { metadata = JSON.parse(String(rows[0].metadata || '{}')) } catch { /* unreadable metadata: not shareable */ }
                row = { content: String(rows[0].content || ''), metadata }
            }
        } catch { /* lookup is best effort; the local delete still happens */ }
        await table.delete(`id = '${safeId}'`)
        console.log(`[LanceDB] 🗑️ Gelöscht: ${safeId}`)
        // UEB-17: forgetting must also remove the shared/mesh copy.
        if (row?.content && isMeshShareable(row.metadata)) {
            try {
                const { forgetSharedMemory } = await import('../mesh/mesh-memory-sync.js')
                await forgetSharedMemory({ content: redactSecrets(row.content) }, { broadcast: true })
            } catch { /* mesh not available */ }
        }
        return true
    } catch (err) {
        console.error(`[LanceDB] Löschen fehlgeschlagen: ${err}`)
        return false
    }
}

/**
 * Statistiken
 */
export async function getStats(): Promise<{
    initialized: boolean
    totalEntries: number
    byType: Record<string, number>
}> {
    if (!await ensureInitialized()) {
        return { initialized: false, totalEntries: 0, byType: {} }
    }

    try {
        const count = await table.countRows()

        // Count by type - simplified
        const all = await table.search([]).limit(10000).toArray()
        const byType: Record<string, number> = {}
        for (const entry of all) {
            byType[entry.type] = (byType[entry.type] || 0) + 1
        }

        return {
            initialized: true,
            totalEntries: count,
            byType,
        }
    } catch {
        return { initialized: true, totalEntries: 0, byType: {} }
    }
}

// ============================================
// Migration Helper
// ============================================

/**
 * Migriert alte TF-IDF Daten zu LanceDB
 */
export async function migrateFromVectorMemory(): Promise<number> {
    const oldPath = join(DATA_DIR, 'vector-memory.json')

    if (!existsSync(oldPath)) {
        console.log('[LanceDB] Keine alten Daten zum Migrieren')
        return 0
    }

    try {
        const oldData = JSON.parse(readFileSync(oldPath, 'utf-8'))
        let migrated = 0

        for (const entry of oldData.documents || []) {
            if (!await exists(entry.content)) {
                await remember(entry.content, 'fact', 'migration', {
                    migratedAt: Date.now(),
                    originalId: entry.id,
                })
                migrated++
            }
        }

        console.log(`[LanceDB] ✅ ${migrated} Einträge migriert`)
        return migrated
    } catch (err) {
        console.error(`[LanceDB] Migration fehlgeschlagen: ${err}`)
        return 0
    }
}

// ============================================
// Export
// ============================================

export default {
    ensureInitialized,
    remember,
    recall,
    exists,
    forget,
    getStats,
    migrateFromVectorMemory,
}
