/**
 * Nova Layer 6 - Vector Memory System
 * 
 * Full vector store with semantic search using local embeddings.
 * No external API needed - uses @xenova/transformers for embeddings.
 * 
 * Features:
 * - Per-user memory isolation
 * - Cross-session persistence
 * - Semantic similarity search
 * - Keyword + vector hybrid search
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pushSharedMemory } from './shared-memory.js'

// ============================================
// Types
// ============================================

export interface MemoryEntry {
    id: string
    userId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: number
    embedding?: number[]  // Vector embedding
    metadata?: {
        sessionId?: string
        channel?: string
        tool?: string
        importance?: number  // 0-1, higher = more important
    }
}

export interface MemorySearchResult {
    entry: MemoryEntry
    score: number
    matchType: 'semantic' | 'keyword' | 'hybrid'
}

export interface VectorMemoryConfig {
    dataDir: string
    embeddingModel?: string  // Default: all-MiniLM-L6-v2
    maxEntriesPerUser?: number
    similarityThreshold?: number
}

// ============================================
// Embedding Backend — Ollama first, TF-IDF fallback
// ============================================

// Cache: embedding backend state
let _ollamaEmbedAvailable: boolean | null = null  // null = not yet probed
let _ollamaEmbedModel = 'nomic-embed-text:v1.5'
let _ollamaEmbedDim = 768  // nomic-embed-text output dimension

const EMBED_CANDIDATES = [
    'nomic-embed-text:v1.5',
    'nomic-embed-text',
    'mxbai-embed-large:v1',
    'mxbai-embed-large',
    'bge-m3',
    'all-minilm',
]

/** Try to find a running Ollama embed model. Result is cached. */
async function detectOllamaEmbed(): Promise<{ available: boolean; model: string; dim: number }> {
    try {
        const res = await fetch('http://localhost:11434/api/tags', {
            signal: AbortSignal.timeout(2000),
        })
        if (!res.ok) return { available: false, model: '', dim: 128 }

        const data = await res.json() as { models?: Array<{ name: string }> }
        const installed = (data.models || []).map(m => m.name.toLowerCase())

        for (const candidate of EMBED_CANDIDATES) {
            if (installed.some(m => m.startsWith(candidate.split(':')[0]))) {
                const actualName = installed.find(m => m.startsWith(candidate.split(':')[0])) || candidate
                const dim = actualName.includes('mxbai') ? 1024 : 768
                console.log(`[VectorMemory] ✅ Ollama Embed entdeckt: ${actualName} (${dim}d)`)
                return { available: true, model: actualName, dim }
            }
        }
    } catch { /* Ollama not running */ }

    return { available: false, model: '', dim: 128 }
}

/** Get real embeddings from Ollama. Returns null on failure. */
async function ollamaEmbed(text: string, model: string): Promise<number[] | null> {
    try {
        const res = await fetch('http://localhost:11434/api/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: text }),
            signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) return null
        const data = await res.json() as { embeddings?: number[][], embedding?: number[] }
        return data.embeddings?.[0] || data.embedding || null
    } catch {
        return null
    }
}

/** Main embedding function: Ollama if available, TF-IDF fallback */
async function getEmbedding(text: string): Promise<number[]> {
    // Probe Ollama once per process lifetime (or after first failure)
    if (_ollamaEmbedAvailable === null) {
        const probe = await detectOllamaEmbed()
        _ollamaEmbedAvailable = probe.available
        if (probe.available) {
            _ollamaEmbedModel = probe.model
            _ollamaEmbedDim = probe.dim
        }
    }

    if (_ollamaEmbedAvailable) {
        const vec = await ollamaEmbed(text, _ollamaEmbedModel)
        if (vec && vec.length > 0) return vec

        // Ollama failed at runtime — fall back and disable for this session
        console.warn('[VectorMemory] ⚠️ Ollama Embed failed — fallback to TF-IDF')
        _ollamaEmbedAvailable = false
    }

    return simpleEmbedding(text)
}

/** Synchronous TF-IDF embedding — used as fallback & for existing entries */
function simpleEmbedding(text: string): number[] {
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2)
    const wordFreq = new Map<string, number>()

    for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1)
    }

    // Hash words to fixed-size vector (128 dimensions)
    const vector = new Array(128).fill(0)
    for (const [word, freq] of wordFreq) {
        const hash = simpleHash(word) % 128
        vector[hash] += freq
    }

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
    if (magnitude > 0) {
        for (let i = 0; i < vector.length; i++) {
            vector[i] /= magnitude
        }
    }

    return vector
}

function simpleHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i)
        hash |= 0
    }
    return Math.abs(hash)
}

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0

    let dotProduct = 0
    let magA = 0
    let magB = 0

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i]
        magA += a[i] * a[i]
        magB += b[i] * b[i]
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB)
    return magnitude > 0 ? dotProduct / magnitude : 0
}

// ============================================
// Vector Memory Store
// ============================================

export class VectorMemoryStore {
    private dataDir: string
    private entriesByUser: Map<string, MemoryEntry[]> = new Map()
    private maxEntriesPerUser: number
    private similarityThreshold: number
    private initialized = false

    constructor(config: VectorMemoryConfig) {
        this.dataDir = config.dataDir
        this.maxEntriesPerUser = config.maxEntriesPerUser || 1000
        this.similarityThreshold = config.similarityThreshold || 0.3
    }

    async initialize(): Promise<void> {
        if (this.initialized) return

        // Create data directory
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }

        // Load existing memories
        this.loadFromDisk()
        this.initialized = true

        // Probe Ollama embed in background — warm the cache
        detectOllamaEmbed().then(probe => {
            if (probe.available) {
                _ollamaEmbedAvailable = true
                _ollamaEmbedModel = probe.model
                _ollamaEmbedDim = probe.dim
            } else {
                if (_ollamaEmbedAvailable === null) _ollamaEmbedAvailable = false
            }
        }).catch(() => {
            if (_ollamaEmbedAvailable === null) _ollamaEmbedAvailable = false
        })

        const embedBackend = _ollamaEmbedAvailable ? `Ollama (${_ollamaEmbedModel})` : 'TF-IDF (fallback)'
        console.log(`[VectorMemory] Initialisiert: ${this.getTotalEntries()} Einträge — Embedding: ${embedBackend}`)
    }

    // ============================================
    // Storage Operations
    // ============================================

    async store(entry: Omit<MemoryEntry, 'id' | 'embedding'>): Promise<MemoryEntry> {
        if (!this.initialized) await this.initialize()

        const fullEntry: MemoryEntry = {
            ...entry,
            id: crypto.randomUUID(),
            embedding: await getEmbedding(entry.content),
        }

        // Add to user's entries
        if (!this.entriesByUser.has(entry.userId)) {
            this.entriesByUser.set(entry.userId, [])
        }

        const userEntries = this.entriesByUser.get(entry.userId)!
        userEntries.push(fullEntry)

        // Trim if exceeds max
        if (userEntries.length > this.maxEntriesPerUser) {
            // Keep most important and recent
            userEntries.sort((a, b) => {
                const importanceA = a.metadata?.importance || 0.5
                const importanceB = b.metadata?.importance || 0.5
                if (importanceA !== importanceB) return importanceB - importanceA
                return b.timestamp - a.timestamp
            })
            userEntries.splice(this.maxEntriesPerUser)
        }

        this.saveToDisk()
        pushSharedMemory({
            id: fullEntry.id,
            userId: fullEntry.userId,
            role: fullEntry.role,
            content: fullEntry.content,
            timestamp: fullEntry.timestamp,
            scope: 'vector-memory',
            metadata: fullEntry.metadata,
        }).catch(() => { })
        return fullEntry
    }

    async search(
        query: string,
        userId: string,
        limit = 5
    ): Promise<MemorySearchResult[]> {
        if (!this.initialized) await this.initialize()

        const userEntries = this.entriesByUser.get(userId) || []
        if (userEntries.length === 0) return []

        // Use real embeddings for query (same backend used for storage)
        const queryEmbedding = await getEmbedding(query)
        const queryKeywords = new Set(
            query.toLowerCase().split(/\W+/).filter(w => w.length > 2)
        )

        // Score all entries
        const scored: MemorySearchResult[] = []

        for (const entry of userEntries) {
            // Vector similarity — if dimensions mismatch (old TF-IDF vs new Ollama),
            // fall back to pure keyword matching for that entry
            let vectorScore = 0
            if (entry.embedding && entry.embedding.length > 0) {
                if (entry.embedding.length === queryEmbedding.length) {
                    vectorScore = cosineSimilarity(queryEmbedding, entry.embedding)
                } else {
                    // Dimension mismatch: re-embed this entry synchronously with simple embedding
                    // (will be re-indexed on next store call)
                    const reEmbedded = simpleEmbedding(entry.content)
                    const querySimple = simpleEmbedding(query)
                    vectorScore = cosineSimilarity(querySimple, reEmbedded) * 0.5  // Lower weight
                }
            }

            // Keyword matching (always computed — catches exact matches regardless of embedding quality)
            const entryWords = new Set(
                entry.content.toLowerCase().split(/\W+/).filter(w => w.length > 2)
            )
            const commonWords = [...queryKeywords].filter(w => entryWords.has(w))
            const keywordScore = queryKeywords.size > 0
                ? commonWords.length / queryKeywords.size
                : 0

            // Hybrid score:
            // - With real Ollama embeddings: 75% vector, 25% keyword
            // - With TF-IDF fallback: 50% vector, 50% keyword (less trust in vectors)
            const vectorWeight = _ollamaEmbedAvailable ? 0.75 : 0.5
            const hybridScore = vectorScore * vectorWeight + keywordScore * (1 - vectorWeight)

            // Lower threshold when using better embeddings
            const threshold = _ollamaEmbedAvailable
                ? Math.max(0.2, this.similarityThreshold - 0.1)
                : this.similarityThreshold

            if (hybridScore >= threshold) {
                scored.push({
                    entry,
                    score: hybridScore,
                    matchType: vectorScore > keywordScore ? 'semantic' :
                        keywordScore > vectorScore ? 'keyword' : 'hybrid',
                })
            }
        }

        // Sort by score and return top results
        scored.sort((a, b) => b.score - a.score)
        return scored.slice(0, limit)
    }

    async recall(query: string, userId: string, limit = 5): Promise<MemoryEntry[]> {
        const results = await this.search(query, userId, limit)
        return results.map(r => r.entry)
    }

    // ============================================
    // Cross-Session Operations
    // ============================================

    async getRecentEntries(userId: string, limit = 10): Promise<MemoryEntry[]> {
        if (!this.initialized) await this.initialize()

        const userEntries = this.entriesByUser.get(userId) || []
        return [...userEntries]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit)
    }

    async getEntriesByTimeRange(
        userId: string,
        startTime: number,
        endTime: number
    ): Promise<MemoryEntry[]> {
        if (!this.initialized) await this.initialize()

        const userEntries = this.entriesByUser.get(userId) || []
        return userEntries.filter(e =>
            e.timestamp >= startTime && e.timestamp <= endTime
        )
    }

    async markImportant(entryId: string, importance: number): Promise<void> {
        for (const entries of this.entriesByUser.values()) {
            const entry = entries.find(e => e.id === entryId)
            if (entry) {
                entry.metadata = entry.metadata || {}
                entry.metadata.importance = Math.max(0, Math.min(1, importance))
                this.saveToDisk()
                return
            }
        }
    }

    // ============================================
    // Persistence
    // ============================================

    private loadFromDisk(): void {
        const indexPath = join(this.dataDir, 'index.json')
        if (!existsSync(indexPath)) return

        try {
            const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
            for (const [userId, entries] of Object.entries(data)) {
                this.entriesByUser.set(userId, entries as MemoryEntry[])
            }
        } catch (err) {
            console.error('[VectorMemory] Fehler beim Laden:', err)
        }
    }

    private saveToDisk(): void {
        const indexPath = join(this.dataDir, 'index.json')
        const data: Record<string, MemoryEntry[]> = {}

        for (const [userId, entries] of this.entriesByUser) {
            data[userId] = entries
        }

        try {
            writeFileSync(indexPath, JSON.stringify(data, null, 2))
        } catch (err) {
            console.error('[VectorMemory] Fehler beim Speichern:', err)
        }
    }

    // ============================================
    // Stats
    // ============================================

    getTotalEntries(): number {
        let total = 0
        for (const entries of this.entriesByUser.values()) {
            total += entries.length
        }
        return total
    }

    getUserCount(): number {
        return this.entriesByUser.size
    }

    getStats() {
        return {
            totalEntries: this.getTotalEntries(),
            userCount: this.getUserCount(),
            dataDir: this.dataDir,
        }
    }
}

// ============================================
// Global Instance
// ============================================

let memoryStore: VectorMemoryStore | null = null

export function getVectorMemory(config?: Partial<VectorMemoryConfig>): VectorMemoryStore {
    if (!memoryStore) {
        memoryStore = new VectorMemoryStore({
            dataDir: config?.dataDir || join(process.cwd(), '.nova-vector-memory'),
            maxEntriesPerUser: config?.maxEntriesPerUser || 1000,
            similarityThreshold: config?.similarityThreshold || 0.3,
        })
    }
    return memoryStore
}

export default {
    VectorMemoryStore,
    getVectorMemory,
}
