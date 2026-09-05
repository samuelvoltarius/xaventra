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

        // Auto-share to mesh network
        try {
            const { shareMemory } = await import('../mesh/mesh-memory-sync.js')
            shareMemory(content, type as any, source).catch(() => { })
        } catch { /* mesh not available */ }

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
    typeFilter?: MemoryEntry['type']
): Promise<SearchResult[]> {
    // Input validation
    if (!query || typeof query !== 'string') {
        console.warn('[LanceDB] recall called with invalid query')
        return []
    }

    if (!await ensureInitialized()) return []

    try {
        // 1) Query expansion (rule-based, fast)
        const expandedQuery = expandQueryRuleBased(query)

        // 2) Get embedding for expanded query
        const queryEmbedding = await getEmbedding(expandedQuery)

        // 3) Fetch more candidates than needed (for re-ranking)
        const candidateCount = Math.max(limit * 3, 15)
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
        await table.delete(`id = '${safeId}'`)
        console.log(`[LanceDB] 🗑️ Gelöscht: ${safeId}`)
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
