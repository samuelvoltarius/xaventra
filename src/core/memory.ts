/**
 * Nova - Memory Manager
 * 
 * Manages conversation memory with semantic search capability.
 * Uses vector embeddings for relevant context retrieval.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-storage.js'

// ============================================
// Types
// ============================================

export interface MemoryEntry {
    id: string
    timestamp: number
    role: 'user' | 'assistant' | 'system'
    content: string
    metadata?: {
        channel?: string
        userId?: string
        topic?: string
        importance?: number
    }
    embedding?: number[]  // Vector embedding for semantic search
}

export interface ConversationMemory {
    id: string
    startedAt: number
    lastUpdatedAt: number
    messages: MemoryEntry[]
    summary?: string
    tags?: string[]
}

export interface MemoryConfig {
    storagePath?: string
    maxEntriesPerConversation?: number
    maxTotalEntries?: number
    enableSemantic?: boolean
    embeddingModel?: string
}

// ============================================
// Memory Manager
// ============================================

export class MemoryManager {
    private config: Required<MemoryConfig>
    private conversations: Map<string, ConversationMemory> = new Map()
    private shortTermMemory: MemoryEntry[] = []
    private _saveTimer: NodeJS.Timeout | null = null
    private _dirtyConversations: Set<string> = new Set()
    private _deletedConversations: Set<string> = new Set()

    constructor(config: MemoryConfig = {}) {
        this.config = {
            storagePath: config.storagePath ?? '.nova/memory',
            maxEntriesPerConversation: config.maxEntriesPerConversation ?? 100,
            maxTotalEntries: config.maxTotalEntries ?? 1000,
            enableSemantic: config.enableSemantic ?? false,
            embeddingModel: config.embeddingModel ?? 'text-embedding-3-small',
        }

        this.loadFromDisk()
    }

    // ============================================
    // Storage
    // ============================================

    private loadFromDisk(): void {
        const indexPath = join(this.config.storagePath, 'index.json')

        if (!existsSync(indexPath)) return

        try {
            const data = readFileSync(indexPath, 'utf-8')
            const index = JSON.parse(data) as { conversationIds: string[] }

            for (const id of index.conversationIds) {
                const convPath = join(this.config.storagePath, `${id}.json`)
                if (existsSync(convPath)) {
                    const convData = readFileSync(convPath, 'utf-8')
                    this.conversations.set(id, JSON.parse(convData))
                }
            }

            console.log(`[Memory] Loaded ${this.conversations.size} conversations`)
        } catch (err) {
            console.warn('[Memory] Failed to load memory:', err)
        }
    }

    private scheduleSave(conversationId: string): void {
        this._dirtyConversations.add(conversationId)
        if (this._saveTimer) return
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null
            this._flushToDisk().catch(console.error)
        }, 3000) // debounce: flush after 3s of inactivity
        this._saveTimer.unref()
    }

    private async _flushToDisk(): Promise<void> {
        if (this._dirtyConversations.size === 0 && this._deletedConversations.size === 0) return
        const dirty = new Set(this._dirtyConversations)
        const deleted = new Set(this._deletedConversations)
        this._dirtyConversations.clear()
        this._deletedConversations.clear()

        if (!existsSync(this.config.storagePath)) {
            mkdirSync(this.config.storagePath, { recursive: true })
        }

        const writes: Promise<void>[] = []

        // Save index only if new conversations were added
        const indexPath = join(this.config.storagePath, 'index.json')
        const index = { conversationIds: Array.from(this.conversations.keys()) }
        writes.push(atomicWriteJson(indexPath, index))

        // Save only dirty conversations
        for (const id of dirty) {
            const conv = this.conversations.get(id)
            if (!conv) continue
            const convPath = join(this.config.storagePath, `${id}.json`)
            writes.push(atomicWriteJson(convPath, conv))
        }

        for (const id of deleted) {
            writes.push(rm(join(this.config.storagePath, `${id}.json`), { force: true }))
        }

        await Promise.all(writes)
    }

    /** Persist pending changes immediately, e.g. during graceful shutdown. */
    async flush(): Promise<void> {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer)
            this._saveTimer = null
        }
        await this._flushToDisk()
    }

    // ============================================
    // Conversation Management
    // ============================================

    startConversation(id?: string): string {
        const conversationId = id ?? `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        this.conversations.set(conversationId, {
            id: conversationId,
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
            messages: [],
        })

        this.scheduleSave(conversationId)

        console.log(`[Memory] Started conversation: ${conversationId}`)
        return conversationId
    }

    addMessage(conversationId: string, role: MemoryEntry['role'], content: string, metadata?: MemoryEntry['metadata']): void {
        let conv = this.conversations.get(conversationId)

        if (!conv) {
            this.startConversation(conversationId)
            conv = this.conversations.get(conversationId)!
        }

        const entry: MemoryEntry = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: Date.now(),
            role,
            content,
            metadata,
        }

        conv.messages.push(entry)
        conv.lastUpdatedAt = Date.now()

        // Also add to short-term memory
        this.shortTermMemory.push(entry)

        // Trim if needed
        if (conv.messages.length > this.config.maxEntriesPerConversation) {
            conv.messages = conv.messages.slice(-this.config.maxEntriesPerConversation)
        }

        if (this.shortTermMemory.length > 50) {
            this.shortTermMemory = this.shortTermMemory.slice(-50)
        }

        // Async debounced save (non-blocking)
        this.scheduleSave(conversationId)
    }

    // ============================================
    // Retrieval
    // ============================================

    getConversation(conversationId: string): ConversationMemory | null {
        return this.conversations.get(conversationId) ?? null
    }

    getRecentMessages(conversationId: string, count: number = 10): MemoryEntry[] {
        const conv = this.conversations.get(conversationId)
        if (!conv) return []
        return conv.messages.slice(-count)
    }

    getShortTermMemory(): MemoryEntry[] {
        return [...this.shortTermMemory]
    }

    // ============================================
    // Context Building
    // ============================================

    /**
     * Build context for LLM from memory
     * Returns messages that fit within token budget
     */
    buildContext(conversationId: string, maxTokens: number = 4000): Array<{ role: string; content: string }> {
        const conv = this.conversations.get(conversationId)
        if (!conv) return []

        const result: Array<{ role: string; content: string }> = []
        let estimatedTokens = 0

        // Work backwards from most recent
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            const msg = conv.messages[i]
            const msgTokens = Math.ceil(msg.content.length / 4)  // Rough estimate

            if (estimatedTokens + msgTokens > maxTokens) break

            result.unshift({ role: msg.role, content: msg.content })
            estimatedTokens += msgTokens
        }

        return result
    }

    // ============================================
    // Search
    // ============================================

    searchConversations(query: string, limit: number = 5): MemoryEntry[] {
        const queryLower = query.toLowerCase()
        if (!queryLower || limit <= 0) return []
        const results: Array<{ entry: MemoryEntry; score: number }> = []

        for (const conv of this.conversations.values()) {
            for (const msg of conv.messages) {
                if (msg.content.toLowerCase().includes(queryLower)) {
                    // Simple text match scoring
                    const contentLower = msg.content.toLowerCase()
                    let occurrences = 0
                    let offset = 0
                    while ((offset = contentLower.indexOf(queryLower, offset)) !== -1) {
                        occurrences++
                        offset += queryLower.length
                    }
                    results.push({ entry: msg, score: occurrences })
                }
            }
        }

        // Sort by score and return top results
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(r => r.entry)
    }

    // ============================================
    // Stats
    // ============================================

    getStats(): { conversations: number; totalMessages: number; shortTermSize: number } {
        let totalMessages = 0
        for (const conv of this.conversations.values()) {
            totalMessages += conv.messages.length
        }

        return {
            conversations: this.conversations.size,
            totalMessages,
            shortTermSize: this.shortTermMemory.length,
        }
    }

    // ============================================
    // Cleanup
    // ============================================

    clearConversation(conversationId: string): boolean {
        const deleted = this.conversations.delete(conversationId)
        if (deleted) {
            this._dirtyConversations.delete(conversationId)
            this._deletedConversations.add(conversationId)
            this.scheduleSave(conversationId)
        }
        return deleted
    }

    clearAll(): void {
        for (const id of this.conversations.keys()) {
            this._deletedConversations.add(id)
        }
        this.conversations.clear()
        this.shortTermMemory = []
        this._dirtyConversations.clear()
        if (this._deletedConversations.size > 0) {
            this.scheduleSave('__index__')
        }
    }
}

// ============================================
// Singleton
// ============================================

let memoryInstance: MemoryManager | null = null

export function getMemoryManager(config?: MemoryConfig): MemoryManager {
    if (!memoryInstance) {
        memoryInstance = new MemoryManager(config)
    }
    return memoryInstance
}

export default {
    MemoryManager,
    getMemoryManager,
}
