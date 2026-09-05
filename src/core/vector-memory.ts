/**
 * Nova - Vector Memory
 * 
 * Semantic memory using LanceDB for vector storage and search.
 * Supports embedding generation via multiple providers.
 */

import { existsSync, mkdirSync } from 'node:fs'

// ============================================
// Types
// ============================================

export interface VectorEntry {
    id: string
    content: string
    embedding: number[]
    metadata: {
        timestamp: number
        role: 'user' | 'assistant' | 'system'
        conversationId?: string
        channel?: string
        importance?: number
    }
}

export interface SearchResult {
    entry: VectorEntry
    score: number
    distance: number
}

export interface VectorMemoryConfig {
    dbPath?: string
    tableName?: string
    embeddingDimension?: number
    embeddingProvider?: 'openai' | 'ollama' | 'local'
    ollamaEmbeddingModel?: string  // e.g. 'nomic-embed-text', 'mxbai-embed-large'
    ollamaHost?: string            // e.g. 'http://localhost:11434'
}

// ============================================
// Vector Memory Manager
// ============================================

// ============================================
// Embedding LRU Cache (process-level, shared across all VectorMemory instances)
// ============================================

interface EmbeddingCacheEntry { embedding: number[]; cachedAt: number }
const EMBEDDING_CACHE = new Map<string, EmbeddingCacheEntry>()
const EMBEDDING_CACHE_MAX = 1000
const EMBEDDING_CACHE_TTL = 60 * 60 * 1000 // 1 hour

function getCachedEmbedding(text: string): number[] | null {
    const entry = EMBEDDING_CACHE.get(text)
    if (!entry) return null
    if (Date.now() - entry.cachedAt > EMBEDDING_CACHE_TTL) { EMBEDDING_CACHE.delete(text); return null }
    return entry.embedding
}

function setCachedEmbedding(text: string, embedding: number[]): void {
    if (EMBEDDING_CACHE.size >= EMBEDDING_CACHE_MAX) {
        // Evict oldest entry
        const oldest = EMBEDDING_CACHE.keys().next().value
        if (oldest) EMBEDDING_CACHE.delete(oldest)
    }
    EMBEDDING_CACHE.set(text, { embedding, cachedAt: Date.now() })
}

// Singleton OpenAI client for embeddings
let _openaiEmbeddingClient: unknown = null

export class VectorMemory {
    private config: Required<VectorMemoryConfig>
    private db: unknown = null
    private table: unknown = null
    private initialized = false

    constructor(config: VectorMemoryConfig = {}) {
        this.config = {
            dbPath: config.dbPath ?? '.nova/vector-db',
            tableName: config.tableName ?? 'memories',
            embeddingDimension: config.embeddingDimension ?? 768,
            embeddingProvider: config.embeddingProvider ?? 'openai',
            ollamaEmbeddingModel: config.ollamaEmbeddingModel ?? 'nomic-embed-text',
            ollamaHost: config.ollamaHost ?? 'http://localhost:11434',
        }
    }

    // ============================================
    // Initialization
    // ============================================

    async initialize(): Promise<void> {
        if (this.initialized) return

        // Ensure directory exists
        if (!existsSync(this.config.dbPath)) {
            mkdirSync(this.config.dbPath, { recursive: true })
        }

        try {
            // Dynamic import LanceDB
            const lancedb = await import('@lancedb/lancedb')

            // Connect to database
            this.db = await lancedb.connect(this.config.dbPath)

            // Check if table exists, create if not
            const tableNames = await (this.db as { tableNames: () => Promise<string[]> }).tableNames()

            if (tableNames.includes(this.config.tableName)) {
                this.table = await (this.db as { openTable: (name: string) => Promise<unknown> }).openTable(this.config.tableName)
            } else {
                // Create table with initial schema
                const initialData = [{
                    id: '_init_',
                    content: '',
                    vector: new Array(this.config.embeddingDimension).fill(0),
                    timestamp: Date.now(),
                    role: 'system',
                    conversationId: '',
                    channel: '',
                    importance: 0,
                }]

                this.table = await (this.db as { createTable: (name: string, data: unknown[]) => Promise<unknown> })
                    .createTable(this.config.tableName, initialData)
            }

            this.initialized = true
            console.log(`[VectorMemory] Initialized with LanceDB (provider: ${this.config.embeddingProvider})`)
        } catch (err) {
            console.error('[VectorMemory] Failed to initialize:', err)
            throw err
        }
    }

    // ============================================
    // Embedding Generation
    // ============================================

    async generateEmbedding(text: string): Promise<number[]> {
        const cached = getCachedEmbedding(text)
        if (cached) return cached

        let result: number[]
        if (this.config.embeddingProvider === 'openai') {
            result = await this.generateOpenAIEmbedding(text)
        } else if (this.config.embeddingProvider === 'ollama') {
            result = await this.generateOllamaEmbedding(text)
        } else {
            result = this.generateLocalEmbedding(text)
        }

        setCachedEmbedding(text, result)
        return result
    }

    private async generateOpenAIEmbedding(text: string): Promise<number[]> {
        try {
            const apiKey = process.env.OPENAI_API_KEY
            if (!apiKey) return this.generateLocalEmbedding(text)

            if (!_openaiEmbeddingClient) {
                const OpenAI = (await import('openai')).default
                _openaiEmbeddingClient = new OpenAI({ apiKey })
            }
            const client = _openaiEmbeddingClient as { embeddings: { create: (opts: unknown) => Promise<{ data: Array<{ embedding: number[] }> }> } }
            const response = await client.embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
                dimensions: 768,
            })

            return response.data[0].embedding
        } catch (err) {
            console.warn('[VectorMemory] OpenAI embedding failed:', err)
            return this.generateLocalEmbedding(text)
        }
    }

    private async generateOllamaEmbedding(text: string): Promise<number[]> {
        try {
            const res = await fetch(`${this.config.ollamaHost}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.config.ollamaEmbeddingModel,
                    prompt: text,
                }),
                signal: AbortSignal.timeout(15000),
            })

            if (!res.ok) {
                console.warn(`[VectorMemory] Ollama embedding failed (${res.status}), using local`)
                return this.generateLocalEmbedding(text)
            }

            const data = await res.json() as { embedding?: number[] }
            if (data.embedding && data.embedding.length > 0) {
                return data.embedding
            }

            return this.generateLocalEmbedding(text)
        } catch (err) {
            console.warn('[VectorMemory] Ollama embedding failed:', err)
            return this.generateLocalEmbedding(text)
        }
    }

    private generateLocalEmbedding(text: string): number[] {
        // Simple local embedding using character-based hashing
        // This is a fallback and not as good as real embeddings
        const dimension = this.config.embeddingDimension
        const embedding = new Array(dimension).fill(0)

        const words = text.toLowerCase().split(/\s+/)
        for (let i = 0; i < words.length; i++) {
            const word = words[i]
            for (let j = 0; j < word.length; j++) {
                const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % dimension
                embedding[idx] += 1 / (1 + Math.log(words.length))
            }
        }

        // Normalize
        const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
        if (magnitude > 0) {
            for (let i = 0; i < dimension; i++) {
                embedding[i] /= magnitude
            }
        }

        return embedding
    }

    // ============================================
    // Storage Operations
    // ============================================

    async store(content: string, metadata: VectorEntry['metadata']): Promise<string> {
        await this.initialize()

        const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const embedding = await this.generateEmbedding(content)

        const record = {
            id,
            content,
            vector: embedding,
            timestamp: metadata.timestamp,
            role: metadata.role,
            conversationId: metadata.conversationId || '',
            channel: metadata.channel || '',
            importance: metadata.importance || 0,
        }

        await (this.table as { add: (data: unknown[]) => Promise<void> }).add([record])

        console.log(`[VectorMemory] Stored: ${id}`)
        return id
    }

    async storeMany(entries: Array<{ content: string; metadata: VectorEntry['metadata'] }>): Promise<string[]> {
        await this.initialize()

        const records = await Promise.all(
            entries.map(async (entry) => {
                const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                const embedding = await this.generateEmbedding(entry.content)

                return {
                    id,
                    content: entry.content,
                    vector: embedding,
                    timestamp: entry.metadata.timestamp,
                    role: entry.metadata.role,
                    conversationId: entry.metadata.conversationId || '',
                    channel: entry.metadata.channel || '',
                    importance: entry.metadata.importance || 0,
                }
            })
        )

        await (this.table as { add: (data: unknown[]) => Promise<void> }).add(records)

        return records.map(r => r.id)
    }

    // ============================================
    // Semantic Search
    // ============================================

    async search(query: string, limit: number = 5): Promise<SearchResult[]> {
        await this.initialize()

        const queryEmbedding = await this.generateEmbedding(query)

        const results = await (this.table as {
            search: (vector: number[]) => {
                limit: (n: number) => {
                    toArray: () => Promise<Array<{
                        id: string
                        content: string
                        vector: number[]
                        timestamp: number
                        role: string
                        conversationId: string
                        channel: string
                        importance: number
                        _distance: number
                    }>>
                }
            }
        }).search(queryEmbedding).limit(limit).toArray()

        return results
            .filter(r => r.id !== '_init_')
            .map(r => ({
                entry: {
                    id: r.id,
                    content: r.content,
                    embedding: r.vector,
                    metadata: {
                        timestamp: r.timestamp,
                        role: r.role as VectorEntry['metadata']['role'],
                        conversationId: r.conversationId,
                        channel: r.channel,
                        importance: r.importance,
                    },
                },
                score: 1 / (1 + r._distance),
                distance: r._distance,
            }))
    }

    async searchSimilar(content: string, limit: number = 5): Promise<SearchResult[]> {
        return this.search(content, limit)
    }

    // ============================================
    // Utility
    // ============================================

    async getStats(): Promise<{ count: number; dbPath: string }> {
        await this.initialize()

        const count = await (this.table as { countRows: () => Promise<number> }).countRows()

        return {
            count: count - 1, // Exclude init row
            dbPath: this.config.dbPath,
        }
    }

    async clear(): Promise<void> {
        await this.initialize()

        // Drop and recreate table
        await (this.db as { dropTable: (name: string) => Promise<void> }).dropTable(this.config.tableName)
        this.table = null
        this.initialized = false

        await this.initialize()
        console.log('[VectorMemory] Cleared all entries')
    }
}

// ============================================
// Singleton
// ============================================

let vectorMemoryInstance: VectorMemory | null = null

export function getVectorMemory(config?: VectorMemoryConfig): VectorMemory {
    if (!vectorMemoryInstance) {
        vectorMemoryInstance = new VectorMemory(config)
    }
    return vectorMemoryInstance
}

export default { VectorMemory, getVectorMemory }
