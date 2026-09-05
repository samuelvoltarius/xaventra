/**
 * Brutusbot - Memory System (LanceDB)
 * 
 * Long-term vector memory with auto-recall and auto-capture.
 * Uses LanceDB for storage and OpenAI for embeddings.
 */

import { randomUUID } from 'node:crypto'

// ============================================
// Types
// ============================================

export const MEMORY_CATEGORIES = ['preference', 'fact', 'decision', 'entity', 'other'] as const
export type MemoryCategory = typeof MEMORY_CATEGORIES[number]

export interface MemoryEntry {
    id: string
    text: string
    vector: number[]
    importance: number
    category: MemoryCategory
    createdAt: number
}

export interface MemorySearchResult {
    entry: MemoryEntry
    score: number
}

export interface MemoryConfig {
    dbPath: string
    embeddingApiKey: string
    embeddingModel?: string
    autoRecall?: boolean
    autoCapture?: boolean
    minScore?: number
}

// ============================================
// LanceDB Connection (Lazy Init)
// ============================================

const TABLE_NAME = 'memories'

export class MemoryDB {
    private db: any = null
    private table: any = null
    private initPromise: Promise<void> | null = null

    constructor(
        private readonly dbPath: string,
        private readonly vectorDim: number = 1536, // text-embedding-3-small default
    ) { }

    private async ensureInitialized(): Promise<void> {
        if (this.table) return
        if (this.initPromise) return this.initPromise

        this.initPromise = this.doInitialize()
        return this.initPromise
    }

    private async doInitialize(): Promise<void> {
        // Dynamic import for LanceDB (only load when needed)
        const lancedb = await import('@lancedb/lancedb')

        this.db = await lancedb.connect(this.dbPath)
        const tables = await this.db.tableNames()

        if (tables.includes(TABLE_NAME)) {
            this.table = await this.db.openTable(TABLE_NAME)
        } else {
            // Create table with schema-defining row
            this.table = await this.db.createTable(TABLE_NAME, [
                {
                    id: '__schema__',
                    text: '',
                    vector: new Array(this.vectorDim).fill(0),
                    importance: 0,
                    category: 'other',
                    createdAt: 0,
                },
            ])
            await this.table.delete('id = "__schema__"')
        }
    }

    async store(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<MemoryEntry> {
        await this.ensureInitialized()

        const fullEntry: MemoryEntry = {
            ...entry,
            id: randomUUID(),
            createdAt: Date.now(),
        }

        await this.table.add([fullEntry])
        return fullEntry
    }

    async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
        await this.ensureInitialized()

        const results = await this.table.vectorSearch(vector).limit(limit).toArray()

        // LanceDB uses L2 distance; convert to similarity score
        const mapped = results.map((row: any) => {
            const distance = row._distance ?? 0
            const score = 1 / (1 + distance)
            return {
                entry: {
                    id: row.id as string,
                    text: row.text as string,
                    vector: row.vector as number[],
                    importance: row.importance as number,
                    category: row.category as MemoryCategory,
                    createdAt: row.createdAt as number,
                },
                score,
            }
        })

        return mapped.filter((r: MemorySearchResult) => r.score >= minScore)
    }

    async delete(id: string): Promise<boolean> {
        await this.ensureInitialized()
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (!uuidRegex.test(id)) {
            throw new Error(`Invalid memory ID format: ${id}`)
        }
        await this.table.delete(`id = '${id}'`)
        return true
    }

    async count(): Promise<number> {
        await this.ensureInitialized()
        return this.table.countRows()
    }
}

// ============================================
// OpenAI Embeddings
// ============================================

export class Embeddings {
    private client: any

    constructor(
        private apiKey: string,
        private model: string = 'text-embedding-3-small',
    ) { }

    private async ensureClient(): Promise<void> {
        if (this.client) return
        const { default: OpenAI } = await import('openai')
        this.client = new OpenAI({ apiKey: this.apiKey })
    }

    async embed(text: string): Promise<number[]> {
        await this.ensureClient()
        const response = await this.client.embeddings.create({
            model: this.model,
            input: text,
        })
        return response.data[0].embedding
    }
}

// ============================================
// Rule-based Capture Filter
// ============================================

const MEMORY_TRIGGERS = [
    /remember|merken|vergiss nicht/i,
    /prefer|bevorzuge|mag lieber/i,
    /entschieden|decided|will use/i,
    /\+\d{10,}/, // Phone numbers
    /[\w.-]+@[\w.-]+\.\w+/, // Emails
    /mein\s+\w+\s+ist|is\s+my/i, // "My X is Y"
    /i (like|prefer|hate|love|want|need)/i,
    /always|never|important|wichtig|immer|nie/i,
]

export function shouldCapture(text: string): boolean {
    if (text.length < 10 || text.length > 500) return false
    // Skip injected context
    if (text.includes('<relevant-memories>')) return false
    // Skip system content
    if (text.startsWith('<') && text.includes('</')) return false
    // Skip formatted responses
    if (text.includes('**') && text.includes('\n-')) return false
    // Skip emoji-heavy content
    const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length
    if (emojiCount > 3) return false

    return MEMORY_TRIGGERS.some((r) => r.test(text))
}

export function detectCategory(text: string): MemoryCategory {
    const lower = text.toLowerCase()
    if (/prefer|bevorzug|like|love|hate|want/i.test(lower)) return 'preference'
    if (/entschieden|decided|will use|werden/i.test(lower)) return 'decision'
    if (/\+\d{10,}|@[\w.-]+\.\w+|heißt|is called/i.test(lower)) return 'entity'
    if (/is|are|has|have|ist|hat|sind/i.test(lower)) return 'fact'
    return 'other'
}

// ============================================
// Memory Manager (High-Level API)
// ============================================

export class MemoryManager {
    private db: MemoryDB
    private embeddings: Embeddings
    private config: MemoryConfig

    constructor(config: MemoryConfig) {
        this.config = {
            autoRecall: true,
            autoCapture: true,
            minScore: 0.3,
            embeddingModel: 'text-embedding-3-small',
            ...config,
        }

        this.db = new MemoryDB(config.dbPath)
        this.embeddings = new Embeddings(config.embeddingApiKey, this.config.embeddingModel!)
    }

    /**
     * Recall relevant memories for a query
     */
    async recall(query: string, limit = 5): Promise<MemorySearchResult[]> {
        const vector = await this.embeddings.embed(query)
        return this.db.search(vector, limit, this.config.minScore!)
    }

    /**
     * Store a new memory
     */
    async store(text: string, options: { importance?: number; category?: MemoryCategory } = {}): Promise<MemoryEntry | null> {
        const vector = await this.embeddings.embed(text)

        // Check for duplicates
        const existing = await this.db.search(vector, 1, 0.95)
        if (existing.length > 0) {
            console.log(`[Memory] Duplicate found: "${existing[0].entry.text.slice(0, 50)}..."`)
            return null
        }

        return this.db.store({
            text,
            vector,
            importance: options.importance ?? 0.7,
            category: options.category ?? detectCategory(text),
        })
    }

    /**
     * Forget a memory by ID
     */
    async forget(id: string): Promise<boolean> {
        return this.db.delete(id)
    }

    /**
     * Find and potentially delete memories by query
     */
    async findToForget(query: string): Promise<MemorySearchResult[]> {
        const vector = await this.embeddings.embed(query)
        return this.db.search(vector, 5, 0.7)
    }

    /**
     * Get total memory count
     */
    async count(): Promise<number> {
        return this.db.count()
    }

    /**
     * Auto-capture: analyze conversation for memorable content
     */
    async autoCapture(messages: Array<{ role: string; content: string }>): Promise<number> {
        if (!this.config.autoCapture) return 0

        let stored = 0
        const userMessages = messages.filter((m) => m.role === 'user')

        for (const msg of userMessages.slice(-3)) { // Last 3 user messages
            if (shouldCapture(msg.content)) {
                const result = await this.store(msg.content)
                if (result) stored++
            }
        }

        return stored
    }

    /**
     * Generate context string from recalled memories
     */
    async getContextForPrompt(userMessage: string): Promise<string | null> {
        if (!this.config.autoRecall) return null
        if (userMessage.length < 5) return null

        const results = await this.recall(userMessage, 3)
        if (results.length === 0) return null

        const memoryContext = results
            .map((r) => `- [${r.entry.category}] ${r.entry.text}`)
            .join('\n')

        return `<relevant-memories>
The following memories may be relevant:
${memoryContext}
</relevant-memories>`
    }
}

// ============================================
// Default Export
// ============================================

export default {
    MemoryDB,
    MemoryManager,
    Embeddings,
    shouldCapture,
    detectCategory,
    MEMORY_CATEGORIES,
}
