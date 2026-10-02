/**
 * LanceDB Long-Term Memory
 *
 * Knotenlokale Vektor-Projektion der Memory-Governance (ein Schreiber).
 *
 * 2.84 (Punkt 2):
 * - Ein Vektorraum je Tabelle: Die Tabelle gehört genau einem Einbetter
 *   (`lancedb-status.json`: table, embedder, dimension). Geschrieben und
 *   gesucht wird nur mit diesem Einbetter; antwortet er nicht, scheitert der
 *   Eintrag ehrlich (die Governance trägt ihn später nach) statt still in
 *   einen anderen Vektorraum zu fallen.
 * - Einbetter-Wechsel (Hash -> eigener Einbetter, oder der gebundene ist seit
 *   24 h weg): neue Tabelle, die Governance projiziert begrenzt neu.
 * - Zählung über countRows() (mit Filter), nie über eine leere Vektorsuche.
 * - Einbettung nur aus eigenen Quellen (embedding-providers.ts).
 */

import lancedb from '@lancedb/lancedb'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { embed, resetEmbeddingDiscovery, parseEmbedderId, type EmbeddingResult } from './embedding-providers.js'
import { hybridRerankResults } from './hybrid-search.js'
import { expandQueryRuleBased } from './query-expansion.js'
import { sideEffectsDisabled } from '../core/side-effects.js'

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

/** Die aktive Projektion: Tabelle und ihr einziger Einbetter. */
export interface ActiveProjection {
    table: string
    embedder: string
    dimension: number
}

export interface LanceStats {
    initialized: boolean
    totalEntries: number
    byType: Record<string, number>
    table?: string
    embedder?: string
    /** Zählung gescheitert: der Grund statt einer falschen 0. */
    error?: string
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

// ============================================
// Configuration
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const DB_PATH = join(DATA_DIR, 'lancedb')
const STATUS_FILE = join(DATA_DIR, 'lancedb-status.json')
const VALID_TYPES = ['conversation', 'learning', 'fact', 'code', 'error_solution'] as const
/** Gebundener Einbetter so lange weg: Wechsel auf den besten verfügbaren. */
const SWITCH_WHEN_UNAVAILABLE_MS = 24 * 60 * 60_000
const PROBE_TEXT = 'Xaventra Gedächtnis'

interface StatusFile {
    initialized?: boolean
    timestamp?: number
    path?: string
    table?: string
    embedder?: string
    dimension?: number
    unavailableSince?: number
    previousTables?: string[]
}

// ============================================
// State
// ============================================

let db: any = null
let table: any = null
let binding: ActiveProjection | null = null
let isInitialized = false
let backfillScheduled = false

// Embedding cache — avoid redundant calls for identical content (per Einbetter)
const embeddingCache = new Map<string, number[]>()
const EMBEDDING_CACHE_MAX = 500

function readStatus(): StatusFile {
    try { return JSON.parse(readFileSync(STATUS_FILE, 'utf-8')) as StatusFile } catch { return {} }
}

function writeStatus(patch: Partial<StatusFile>): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        const next: StatusFile = { ...readStatus(), ...patch, initialized: true, timestamp: Date.now(), path: DB_PATH }
        for (const [key, value] of Object.entries(next)) if (value === undefined) delete (next as any)[key]
        writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2))
    } catch { /* Status ist nur Buchhaltung */ }
}

/** Tabellenname je Einbetter (ein Vektorraum je Tabelle). */
export function tableNameFor(embedder: string): string {
    return `memories_${embedder.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
}

const PROVIDER_RANK: Record<string, number> = { lokal: 2, openai: 1, openrouter: 1, hash: 0 }
const rank = (embedder: string) => PROVIDER_RANK[parseEmbedderId(embedder)?.provider || ''] ?? 0

async function openTableIfExists(name: string): Promise<any | null> {
    const names: string[] = await db.tableNames()
    return names.includes(name) ? db.openTable(name) : null
}

// ============================================
// Embedding (nur der gebundene Einbetter)
// ============================================

async function getEmbedding(text: string): Promise<number[] | null> {
    if (!binding) return null
    const key = `${binding.embedder}\u0000${createHash('sha256').update(text).digest('hex')}`
    const cached = embeddingCache.get(key)
    if (cached) return cached
    const result = await embed(text, { only: binding.embedder })
    if (!result) return null
    if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const firstKey = embeddingCache.keys().next().value
        if (firstKey !== undefined) embeddingCache.delete(firstKey)
    }
    embeddingCache.set(key, result.vector)
    return result.vector
}

function bind(result: Pick<EmbeddingResult, 'embedder' | 'dimension'>, tableName = tableNameFor(result.embedder)): ActiveProjection {
    return { table: tableName, embedder: result.embedder, dimension: result.dimension }
}

// ============================================
// Auto-Initialization
// ============================================

/**
 * Verbindet LanceDB und lädt die gebundene Tabelle. Ohne Bindung (neu oder
 * Altbestand ohne Einbetter) wird an den besten eigenen Einbetter gebunden;
 * die Tabelle entsteht mit dem ersten Eintrag.
 */
export async function ensureInitialized(): Promise<boolean> {
    if (isInitialized) return true

    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        db = await lancedb.connect(DB_PATH)

        const status = readStatus()
        const parsed = parseEmbedderId(status.embedder)
        if (status.table && parsed) {
            binding = { table: status.table, embedder: status.embedder!, dimension: Number(status.dimension) || parsed.dimension }
        } else {
            // Neu oder Altbestand (`memories` ohne bekannten Einbetter, evtl.
            // gemischt): nicht weiter mischen — neue Tabelle, die Governance
            // projiziert neu.
            const best = await embed(PROBE_TEXT, {})
            if (!best) return false
            binding = bind(best)
            const previousTables = (await db.tableNames() as string[]).includes('memories') ? ['memories'] : []
            writeStatus({ table: binding.table, embedder: binding.embedder, dimension: binding.dimension, ...(previousTables.length ? { previousTables } : {}) })
        }
        table = await openTableIfExists(binding.table)
        isInitialized = true
        console.log(`[LanceDB] Langzeitgedächtnis bereit: Tabelle ${binding.table}, Einbetter ${binding.embedder}`)
        scheduleStartupBackfill()
        return true
    } catch (err) {
        console.error(`[LanceDB] ❌ Initialisierung fehlgeschlagen: ${err}`)
        return false
    }
}

/** Beim Start einmal: fehlende/veraltete Projektionen nachtragen (Governance). */
function scheduleStartupBackfill(): void {
    if (backfillScheduled || sideEffectsDisabled()) return
    backfillScheduled = true
    const timer = setTimeout(() => {
        void import('./memory-governance.js')
            .then(({ getMemoryGovernanceCoordinator }) => getMemoryGovernanceCoordinator().maybeBackfillProjections({ force: true }))
            .then(report => { if (report && (report.projected || report.failed)) console.log(`[LanceDB] Nachgetragen: ${report.projected} projiziert, ${report.failed} gescheitert, ${report.pending} offen`) })
            .catch(() => undefined)
    }, 60_000)
    timer.unref?.()
}

/** Aktive Projektion (null vor der Initialisierung). */
export function getActiveProjection(): ActiveProjection | null {
    return binding ? { ...binding } : null
}

/**
 * Wartungslauf: bester verfügbarer eigener Einbetter gegen den gebundenen.
 * Wechsel nur zu einem besseren (Hash -> eigener) oder wenn der gebundene
 * seit 24 h nicht antwortet. Danach projiziert die Governance neu.
 */
export async function reconcileEmbedder(now = Date.now()): Promise<{ switched: boolean; from?: string; to?: string; reason?: string }> {
    if (!await ensureInitialized() || !binding) return { switched: false, reason: 'nicht initialisiert' }
    resetEmbeddingDiscovery()
    const best = await embed(PROBE_TEXT, {})
    if (!best) return { switched: false, reason: 'kein Einbetter' }
    const boundAlive = best.embedder === binding.embedder || (await embed(PROBE_TEXT, { only: binding.embedder })) !== null
    const status = readStatus()
    if (boundAlive && status.unavailableSince) writeStatus({ unavailableSince: undefined })
    if (!boundAlive && !status.unavailableSince) writeStatus({ unavailableSince: now })
    if (best.embedder === binding.embedder) return { switched: false }
    const better = rank(best.embedder) > rank(binding.embedder)
    const goneLongEnough = !boundAlive && now - (status.unavailableSince ?? now) >= SWITCH_WHEN_UNAVAILABLE_MS
    if (!better && !goneLongEnough) return { switched: false, reason: boundAlive ? 'gebundener Einbetter antwortet' : 'gebundener Einbetter erst kurz weg' }
    const from = binding
    binding = bind(best)
    table = await openTableIfExists(binding.table)
    embeddingCache.clear()
    writeStatus({
        table: binding.table, embedder: binding.embedder, dimension: binding.dimension, unavailableSince: undefined,
        previousTables: [...new Set([...(status.previousTables || []), from.table])].filter(name => name !== binding!.table).slice(-10),
    })
    console.log(`[LanceDB] Einbetter gewechselt: ${from.embedder} -> ${binding.embedder} (${better ? 'besser' : 'alter seit 24 h weg'}); Neuaufbau über die Governance`)
    return { switched: true, from: from.embedder, to: binding.embedder, reason: better ? 'besser' : 'nicht erreichbar' }
}

// ============================================
// Memory Operations
// ============================================

/**
 * Speichert einen neuen Eintrag in der aktiven Projektion (nur mit dem
 * gebundenen Einbetter). null, wenn der Einbetter nicht antwortet.
 */
export async function remember(
    content: string,
    type: MemoryEntry['type'] = 'fact',
    source: string = 'nova',
    metadata: Record<string, any> = {},
    options: { timestamp?: number } = {},
): Promise<string | null> {
    if (!content || typeof content !== 'string') {
        console.warn('[LanceDB] remember called with invalid content')
        return null
    }

    if (!await ensureInitialized() || !binding) return null

    try {
        const embedding = await getEmbedding(content)
        if (!embedding || embedding.length !== binding.dimension) {
            console.warn(`[LanceDB] Einbetter ${binding.embedder} nicht erreichbar — Eintrag wird später nachgetragen`)
            return null
        }
        const entry: MemoryEntry = {
            id: `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            embedding,
            type,
            source,
            timestamp: Number.isFinite(options.timestamp) ? Number(options.timestamp) : Date.now(),
            metadata: JSON.stringify({ ...metadata, embedder: binding.embedder }),
        }

        if (table) await table.add([entry])
        else table = await db.createTable(binding.table, [entry])
        // LanceDB is a node-local projection. Memory reaches other nodes only
        // as governance records (L22 federated memory, incl. tombstones).
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
    if (!query || typeof query !== 'string') {
        console.warn('[LanceDB] recall called with invalid query')
        return []
    }

    if (access && access.scopes.length === 0 && access.includeUnscoped !== true) return []
    if (!await ensureInitialized() || !table) return []

    try {
        // 1) Query expansion (rule-based, fast)
        const expandedQuery = expandQueryRuleBased(query)

        // 2) Embedding with the table's own embedder (never a different vector space)
        const queryEmbedding = await getEmbedding(expandedQuery)
        if (!queryEmbedding) return []

        // 3) Fetch more candidates than needed (for re-ranking)
        // Scope filtering happens after the vector search, so over-fetch a bit
        // more when the caller is principal-bound.
        const candidateCount = access ? Math.max(limit * 6, 30) : Math.max(limit * 3, 15)
        let search = table.search(queryEmbedding).limit(candidateCount)

        if (typeFilter && (VALID_TYPES as readonly string[]).includes(typeFilter)) {
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
 * Löscht einen Eintrag — in der aktiven Tabelle oder in `tableName`
 * (Zeilen aus einer früheren Projektion vor einem Einbetter-Wechsel).
 */
export async function forget(id: string, tableName?: string): Promise<boolean> {
    if (!id || typeof id !== 'string' || id.length > 200) {
        console.warn('[LanceDB] forget called with invalid id')
        return false
    }

    if (!await ensureInitialized()) return false

    try {
        const safeId = id.replace(/['"\\;]/g, '')
        const target = tableName && tableName !== binding?.table ? await openTableIfExists(tableName) : table
        if (!target) return true // nichts projiziert, nichts zu löschen
        await target.delete(`id = '${safeId}'`)
        console.log(`[LanceDB] 🗑️ Gelöscht: ${safeId}`)
        return true
    } catch (err) {
        console.error(`[LanceDB] Löschen fehlgeschlagen: ${err}`)
        return false
    }
}

/**
 * Statistiken: echte Zeilenzahl (countRows), je Typ per Filter. Ein Fehler
 * steht in `error`, nicht als 0.
 */
export async function getStats(): Promise<LanceStats> {
    if (!await ensureInitialized()) {
        return { initialized: false, totalEntries: 0, byType: {}, error: 'LanceDB nicht initialisiert' }
    }
    const base = { initialized: true, table: binding?.table, embedder: binding?.embedder }
    if (!table) return { ...base, totalEntries: 0, byType: {} }
    try {
        const totalEntries = Number(await table.countRows())
        const byType: Record<string, number> = {}
        for (const type of VALID_TYPES) {
            const count = Number(await table.countRows(`type = '${type}'`))
            if (count > 0) byType[type] = count
        }
        return { ...base, totalEntries, byType }
    } catch (err) {
        return { ...base, totalEntries: 0, byType: {}, error: String((err as Error)?.message || err).slice(0, 200) }
    }
}

/** Zeilen der aktiven Projektion mit Zeitstempel in [fromMs, toMs] (Lern-Puls). null bei Fehler. */
export async function countRowsBetween(fromMs: number, toMs: number): Promise<number | null> {
    if (!await ensureInitialized()) return null
    if (!table) return 0
    try {
        return Number(await table.countRows(`timestamp >= ${Math.floor(fromMs)} AND timestamp <= ${Math.ceil(toMs)}`))
    } catch { return null }
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
    countRowsBetween,
    getActiveProjection,
    reconcileEmbedder,
}