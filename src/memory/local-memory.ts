/**
 * Nova Local Memory
 * 
 * File-based memory system that works WITHOUT OpenAI API key.
 * Uses simple keyword matching for search (no embeddings required).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pullSharedMemory, pushSharedMemory } from './shared-memory.js'

// ============================================
// Types
// ============================================

export interface MemoryEntry {
    id: string
    userId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: number
    keywords: string[]
}

export interface LocalMemoryConfig {
    dbPath: string
    maxEntriesPerUser?: number
}

// ============================================
// Keyword Extraction (Simple, no ML)
// ============================================

function extractKeywords(text: string): string[] {
    // Remove common stop words
    const stopWords = new Set([
        'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'ich', 'du',
        'er', 'sie', 'es', 'wir', 'ihr', 'sie', 'ist', 'sind', 'war', 'waren',
        'hat', 'haben', 'wird', 'werden', 'kann', 'können', 'muss', 'müssen',
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
        'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
        'that', 'this', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
        'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
        'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
        'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then', 'if',
    ])

    // Extract words, lowercase, filter short words and stop words
    const words = text.toLowerCase()
        .replace(/[^a-zäöüß\s]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w))

    // Return unique keywords
    return [...new Set(words)].slice(0, 20)
}

// ============================================
// Local Memory Manager
// ============================================

export class LocalMemoryManager {
    private config: Required<LocalMemoryConfig>
    private entries: Map<string, MemoryEntry[]> = new Map()

    constructor(config: LocalMemoryConfig) {
        this.config = {
            dbPath: config.dbPath,
            maxEntriesPerUser: config.maxEntriesPerUser ?? 500,
        }
        this.loadFromDisk()
        this.importSharedMemory().catch(() => { })
    }

    // ============================================
    // Persistence
    // ============================================

    private getStorePath(): string {
        return join(this.config.dbPath, 'memory.json')
    }

    private loadFromDisk(): void {
        const path = this.getStorePath()
        if (existsSync(path)) {
            try {
                const data = JSON.parse(readFileSync(path, 'utf-8'))
                for (const [userId, entries] of Object.entries(data)) {
                    this.entries.set(userId, entries as MemoryEntry[])
                }
                console.log(`[Memory] Loaded ${this.entries.size} users from disk`)
            } catch {
                console.log('[Memory] Failed to load, starting fresh')
            }
        }
    }

    private saveToDisk(): void {
        const dir = this.config.dbPath
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        const data: Record<string, MemoryEntry[]> = {}
        for (const [userId, entries] of this.entries) {
            data[userId] = entries
        }

        writeFileSync(this.getStorePath(), JSON.stringify(data, null, 2))
    }

    // ============================================
    // Store
    // ============================================

    async store(entry: { userId: string; role: string; content: string; timestamp: number }): Promise<void> {
        const userId = entry.userId

        if (!this.entries.has(userId)) {
            this.entries.set(userId, [])
        }

        const userEntries = this.entries.get(userId)!

        const memoryEntry: MemoryEntry = {
            id: crypto.randomUUID(),
            userId: entry.userId,
            role: entry.role as 'user' | 'assistant' | 'system',
            content: entry.content,
            timestamp: entry.timestamp,
            keywords: extractKeywords(entry.content),
        }

        userEntries.push(memoryEntry)

        // Limit entries per user
        if (userEntries.length > this.config.maxEntriesPerUser) {
            userEntries.splice(0, userEntries.length - this.config.maxEntriesPerUser)
        }

        this.saveToDisk()
        pushSharedMemory(memoryEntry).catch(() => { })
    }

    private async importSharedMemory(): Promise<void> {
        const remote = await pullSharedMemory({ limit: this.config.maxEntriesPerUser * 5 })
        if (remote.length === 0) return

        let imported = 0
        for (const entry of remote) {
            if (!entry.userId || !entry.content) continue
            const list = this.entries.get(entry.userId) ?? []
            if (list.some(existing => existing.id === entry.id)) continue
            list.push({
                id: entry.id,
                userId: entry.userId,
                role: entry.role,
                content: entry.content,
                timestamp: entry.timestamp,
                keywords: entry.keywords ?? extractKeywords(entry.content),
            })
            list.sort((a, b) => a.timestamp - b.timestamp)
            if (list.length > this.config.maxEntriesPerUser) {
                list.splice(0, list.length - this.config.maxEntriesPerUser)
            }
            this.entries.set(entry.userId, list)
            imported++
        }

        if (imported > 0) {
            this.saveToDisk()
            console.log(`[Memory] Imported ${imported} shared memories from Supabase`)
        }
    }

    // ============================================
    // Recall (Keyword-based search)
    // ============================================

    async recall(query: string, userId: string, limit: number = 5): Promise<Array<{ content: string }>> {
        const userEntries = this.entries.get(userId)
        if (!userEntries || userEntries.length === 0) {
            return []
        }

        const queryKeywords = extractKeywords(query)
        if (queryKeywords.length === 0) {
            // Return most recent if no keywords
            return userEntries
                .slice(-limit)
                .map(e => ({ content: e.content }))
        }

        // Score entries by keyword overlap
        const scored = userEntries.map(entry => {
            const overlap = entry.keywords.filter(k => queryKeywords.includes(k)).length
            return { entry, score: overlap }
        })

        // Sort by score (descending), then by recency
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            return b.entry.timestamp - a.entry.timestamp
        })

        // Return top matches
        return scored
            .filter(s => s.score > 0)
            .slice(0, limit)
            .map(s => ({ content: s.entry.content }))
    }

    // ============================================
    // Stats
    // ============================================

    getStats(): { totalUsers: number; totalEntries: number } {
        let totalEntries = 0
        for (const entries of this.entries.values()) {
            totalEntries += entries.length
        }
        return {
            totalUsers: this.entries.size,
            totalEntries,
        }
    }
}

export default { LocalMemoryManager }
