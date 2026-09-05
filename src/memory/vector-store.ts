/**
 * Nova - Vector Store (LanceDB)
 * 
 * Layer 06: Long-term semantic memory with per-user isolation
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface MemoryEntry {
    id: string
    userId: string
    content: string
    embedding?: number[]
    metadata: {
        channel?: string
        timestamp: number
        type: 'message' | 'fact' | 'teaching' | 'context'
        importance: number  // 0-1
    }
}

export interface SearchResult {
    entry: MemoryEntry
    score: number
}

// ============================================
// Vector Store Class
// ============================================

export class VectorStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private db: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private table: any = null
    private dataDir: string
    private tableName = 'nova_memory'
    private initialized = false

    constructor(dataDir: string = '.nova-memory') {
        this.dataDir = join(process.cwd(), dataDir)
    }

    // ============================================
    // Initialization
    // ============================================

    async init(): Promise<void> {
        if (this.initialized) return

        // Ensure directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }

        try {
            const lancedb = await import('@lancedb/lancedb')
            this.db = await lancedb.connect(this.dataDir)

            // Check if table exists
            const tables = await this.db.tableNames()
            if (tables.includes(this.tableName)) {
                this.table = await this.db.openTable(this.tableName)
                console.log(`[VectorStore] Opened existing table: ${this.tableName}`)
            } else {
                // Create table with initial schema
                this.table = await this.db.createTable(this.tableName, [
                    {
                        id: 'init_000',
                        userId: 'system',
                        content: 'Nova memory initialized',
                        vector: new Array(384).fill(0),  // Default embedding size
                        channel: 'system',
                        timestamp: Date.now(),
                        type: 'fact',
                        importance: 0.1,
                    }
                ])
                console.log(`[VectorStore] Created new table: ${this.tableName}`)
            }

            this.initialized = true
            console.log('[VectorStore] Initialized successfully')
        } catch (err) {
            console.error(`[VectorStore] Init error: ${err}`)
            throw err
        }
    }

    // ============================================
    // Embedding Generation
    // ============================================

    private async generateEmbedding(text: string): Promise<number[]> {
        // Use simple hash-based pseudo-embedding for now
        // In production, this would call an embedding API
        const embedding = new Array(384).fill(0)

        // Simple character-based embedding
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i)
            embedding[i % 384] += charCode / 1000
        }

        // Normalize
        const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
        if (magnitude > 0) {
            for (let i = 0; i < embedding.length; i++) {
                embedding[i] /= magnitude
            }
        }

        return embedding
    }

    // ============================================
    // Memory Operations
    // ============================================

    async addMemory(entry: Omit<MemoryEntry, 'id' | 'embedding'>): Promise<string> {
        if (!this.initialized) await this.init()

        const id = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
        const embedding = await this.generateEmbedding(entry.content)

        await this.table.add([{
            id,
            userId: entry.userId,
            content: entry.content,
            vector: embedding,
            channel: entry.metadata.channel || 'unknown',
            timestamp: entry.metadata.timestamp,
            type: entry.metadata.type,
            importance: entry.metadata.importance,
        }])

        return id
    }

    async searchMemory(userId: string, query: string, k: number = 5): Promise<SearchResult[]> {
        if (!this.initialized) await this.init()

        const queryEmbedding = await this.generateEmbedding(query)

        // Search with user filter
        const results = await this.table
            .search(queryEmbedding)
            .where(`userId = '${userId}'`)
            .limit(k)
            .toArray()

        return results.map((row: { id: string; userId: string; content: string; vector: number[]; channel: string; timestamp: number; type: string; importance: number; _distance: number }) => ({
            entry: {
                id: row.id,
                userId: row.userId,
                content: row.content,
                metadata: {
                    channel: row.channel,
                    timestamp: row.timestamp,
                    type: row.type as MemoryEntry['metadata']['type'],
                    importance: row.importance,
                },
            },
            score: 1 - (row._distance || 0),  // Convert distance to similarity
        }))
    }

    async searchAllMemory(query: string, k: number = 10): Promise<SearchResult[]> {
        if (!this.initialized) await this.init()

        const queryEmbedding = await this.generateEmbedding(query)

        const results = await this.table
            .search(queryEmbedding)
            .limit(k)
            .toArray()

        return results.map((row: { id: string; userId: string; content: string; vector: number[]; channel: string; timestamp: number; type: string; importance: number; _distance: number }) => ({
            entry: {
                id: row.id,
                userId: row.userId,
                content: row.content,
                metadata: {
                    channel: row.channel,
                    timestamp: row.timestamp,
                    type: row.type as MemoryEntry['metadata']['type'],
                    importance: row.importance,
                },
            },
            score: 1 - (row._distance || 0),
        }))
    }

    async getRecentMemories(userId: string, limit: number = 20): Promise<MemoryEntry[]> {
        if (!this.initialized) await this.init()

        const results = await this.table
            .filter(`userId = '${userId}'`)
            .limit(limit)
            .toArray()

        // Sort by timestamp descending
        results.sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp)

        return results.map((row: { id: string; userId: string; content: string; channel: string; timestamp: number; type: string; importance: number }) => ({
            id: row.id,
            userId: row.userId,
            content: row.content,
            metadata: {
                channel: row.channel,
                timestamp: row.timestamp,
                type: row.type as MemoryEntry['metadata']['type'],
                importance: row.importance,
            },
        }))
    }

    async deleteMemory(id: string): Promise<boolean> {
        if (!this.initialized) await this.init()

        try {
            await this.table.delete(`id = '${id}'`)
            return true
        } catch {
            return false
        }
    }

    async deleteUserMemories(userId: string): Promise<number> {
        if (!this.initialized) await this.init()

        try {
            const before = await this.table.countRows()
            await this.table.delete(`userId = '${userId}'`)
            const after = await this.table.countRows()
            return before - after
        } catch {
            return 0
        }
    }

    // ============================================
    // Statistics
    // ============================================

    async getStats(): Promise<{ totalEntries: number; userCounts: Record<string, number> }> {
        if (!this.initialized) await this.init()

        const all = await this.table.toArray()
        const userCounts: Record<string, number> = {}

        for (const row of all) {
            userCounts[row.userId] = (userCounts[row.userId] || 0) + 1
        }

        return {
            totalEntries: all.length,
            userCounts,
        }
    }
}

// ============================================
// Singleton Instance
// ============================================

let globalVectorStore: VectorStore | null = null

export function getVectorStore(): VectorStore {
    if (!globalVectorStore) {
        globalVectorStore = new VectorStore()
    }
    return globalVectorStore
}

export async function initVectorStore(dataDir?: string): Promise<VectorStore> {
    if (!globalVectorStore) {
        globalVectorStore = new VectorStore(dataDir)
    }
    await globalVectorStore.init()
    return globalVectorStore
}
