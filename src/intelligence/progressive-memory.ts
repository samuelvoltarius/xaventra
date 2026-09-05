/**
 * Progressive Memory — Engram-inspired 3-Layer Recall + Topic-Key Upserts
 *
 * Layer 1: Compact Search — brief results with IDs (~100 tokens each)
 * Layer 2: Timeline — what happened before/after a memory
 * Layer 3: Full Recall — complete untruncated content
 *
 * Topic-Key Upserts: memories that evolve instead of duplicating.
 * Same topic_key → update existing entry, increment revision_count.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'progressive-memory')

// ============================================
// Types
// ============================================

export type MemoryType =
    | 'fact'
    | 'preference'
    | 'decision'
    | 'architecture'
    | 'bugfix'
    | 'learning'
    | 'observation'
    | 'pattern'
    | 'config'
    | 'goal'

export interface MemoryEntry {
    id: number
    type: MemoryType
    title: string
    content: string
    topicKey?: string      // For upsert behavior
    scope: 'project' | 'personal' | 'global'
    tags: string[]
    createdAt: number
    updatedAt: number
    revisionCount: number  // How many times this was updated
    accessCount: number    // How many times recalled
    lastAccessedAt: number
    sessionId?: string
    deletedAt?: number     // Soft delete
    importance: number     // 0-10
}

interface MemoryStore {
    entries: MemoryEntry[]
    nextId: number
    stats: {
        totalSaves: number
        totalSearches: number
        totalRecalls: number
        deduplicationsPrevented: number
    }
}

// ============================================
// State
// ============================================

let store: MemoryStore = {
    entries: [],
    nextId: 1,
    stats: { totalSaves: 0, totalSearches: 0, totalRecalls: 0, deduplicationsPrevented: 0 },
}

let initialized = false

// ============================================
// Init / Persistence
// ============================================

export function initProgressiveMemory(): void {
    if (initialized) return

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    const path = join(DATA_DIR, 'memory.json')
    if (existsSync(path)) {
        try {
            store = JSON.parse(readFileSync(path, 'utf-8'))
        } catch { }
    }

    initialized = true
    console.log(`[ProgressiveMemory] ✅ Loaded ${store.entries.filter(e => !e.deletedAt).length} memories`)
}

function save(): void {
    try {
        writeFileSync(join(DATA_DIR, 'memory.json'), JSON.stringify(store, null, 2))
    } catch { }
}

// ============================================
// Topic-Key Upserts (Engram's killer feature)
// ============================================

/**
 * Save or update a memory entry.
 * If topicKey is provided and exists → UPDATE (revision++)
 * If duplicate detected → skip and increment counter
 * Otherwise → INSERT new entry
 */
export function memSave(
    type: MemoryType,
    title: string,
    content: string,
    options: {
        topicKey?: string
        scope?: 'project' | 'personal' | 'global'
        tags?: string[]
        sessionId?: string
        importance?: number
    } = {}
): MemoryEntry {
    initProgressiveMemory()
    store.stats.totalSaves++

    const now = Date.now()
    const scope = options.scope || 'project'

    // Check for topic-key upsert
    if (options.topicKey) {
        const existing = store.entries.find(e =>
            e.topicKey === options.topicKey &&
            e.scope === scope &&
            !e.deletedAt
        )

        if (existing) {
            // UPSERT: Update existing entry
            existing.title = title
            existing.content = content
            existing.updatedAt = now
            existing.revisionCount++
            existing.tags = [...new Set([...existing.tags, ...(options.tags || [])])]
            if (options.importance !== undefined) existing.importance = options.importance
            console.log(`[ProgressiveMemory] 🔄 Updated "${title}" (rev ${existing.revisionCount}, key: ${options.topicKey})`)
            save()
            return existing
        }
    }

    // Check for exact duplicate (same title + type + scope within 1h)
    const recentDup = store.entries.find(e =>
        e.title === title &&
        e.type === type &&
        e.scope === scope &&
        !e.deletedAt &&
        (now - e.createdAt) < 60 * 60 * 1000
    )

    if (recentDup) {
        recentDup.accessCount++
        recentDup.updatedAt = now
        store.stats.deduplicationsPrevented++
        console.log(`[ProgressiveMemory] ⏭️ Dedup: "${title}" already exists`)
        save()
        return recentDup
    }

    // INSERT new entry
    const entry: MemoryEntry = {
        id: store.nextId++,
        type,
        title,
        content,
        topicKey: options.topicKey,
        scope,
        tags: options.tags || [],
        createdAt: now,
        updatedAt: now,
        revisionCount: 1,
        accessCount: 0,
        lastAccessedAt: 0,
        sessionId: options.sessionId,
        importance: options.importance ?? 5,
    }

    store.entries.push(entry)
    console.log(`[ProgressiveMemory] 💾 Saved "${title}" (id: ${entry.id}, type: ${type})`)
    save()
    return entry
}

// ============================================
// Suggest Topic Key (Engram-style families)
// ============================================

export function suggestTopicKey(type: MemoryType, title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40)

    // Family heuristic
    const familyMap: Record<string, string> = {
        architecture: 'architecture',
        decision: 'decision',
        bugfix: 'bug',
        pattern: 'pattern',
        config: 'config',
        learning: 'learning',
        observation: 'discovery',
        fact: 'fact',
        preference: 'preference',
        goal: 'goal',
    }

    const family = familyMap[type] || type
    return `${family}/${slug}`
}

// ============================================
// Layer 1: Compact Search (~100 tokens per result)
// ============================================

export function memSearch(query: string, limit: number = 10): string {
    initProgressiveMemory()
    store.stats.totalSearches++

    const queryLower = query.toLowerCase()
    const words = queryLower.split(/\s+/)

    // Score each entry
    const scored = store.entries
        .filter(e => !e.deletedAt)
        .map(e => {
            let score = 0
            const text = `${e.title} ${e.content} ${e.tags.join(' ')}`.toLowerCase()

            for (const word of words) {
                if (e.title.toLowerCase().includes(word)) score += 10
                if (e.tags.some(t => t.toLowerCase().includes(word))) score += 5
                if (text.includes(word)) score += 2
            }

            // Boost by importance and recency
            score += e.importance
            const ageHours = (Date.now() - e.updatedAt) / (1000 * 60 * 60)
            if (ageHours < 24) score += 5
            if (ageHours < 1) score += 10

            return { entry: e, score }
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

    if (scored.length === 0) return 'Keine Erinnerungen gefunden.'

    // Compact format (~100 tokens per result)
    return scored.map(s => {
        const e = s.entry
        const age = formatAge(e.updatedAt)
        const rev = e.revisionCount > 1 ? ` (rev ${e.revisionCount})` : ''
        return `[${e.id}] ${e.type}/${e.title}${rev} — ${age} — ${e.content.slice(0, 80)}...`
    }).join('\n')
}

// ============================================
// Layer 2: Timeline — what happened around a memory
// ============================================

export function memTimeline(memoryId: number, windowMinutes: number = 30): string {
    initProgressiveMemory()

    const target = store.entries.find(e => e.id === memoryId && !e.deletedAt)
    if (!target) return `Memory #${memoryId} nicht gefunden.`

    const windowMs = windowMinutes * 60 * 1000
    const before = store.entries
        .filter(e => !e.deletedAt && e.createdAt < target.createdAt && (target.createdAt - e.createdAt) < windowMs)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)

    const after = store.entries
        .filter(e => !e.deletedAt && e.createdAt > target.createdAt && (e.createdAt - target.createdAt) < windowMs)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, 5)

    const lines: string[] = []
    lines.push('--- BEFORE ---')
    for (const e of before.reverse()) {
        lines.push(`  [${e.id}] ${e.type}: ${e.title}`)
    }
    lines.push(`→ [${target.id}] ${target.type}: ${target.title}`)
    lines.push('--- AFTER ---')
    for (const e of after) {
        lines.push(`  [${e.id}] ${e.type}: ${e.title}`)
    }

    return lines.join('\n')
}

// ============================================
// Layer 3: Full Recall — complete untruncated content
// ============================================

export function memRecall(memoryId: number): string {
    initProgressiveMemory()
    store.stats.totalRecalls++

    const entry = store.entries.find(e => e.id === memoryId && !e.deletedAt)
    if (!entry) return `Memory #${memoryId} nicht gefunden.`

    // Update access stats
    entry.accessCount++
    entry.lastAccessedAt = Date.now()
    save()

    return `## ${entry.title}
Type: ${entry.type} | Scope: ${entry.scope} | Importance: ${entry.importance}/10
Created: ${new Date(entry.createdAt).toLocaleString('de')}
Updated: ${new Date(entry.updatedAt).toLocaleString('de')}
Revisions: ${entry.revisionCount} | Accessed: ${entry.accessCount}×
${entry.topicKey ? `Topic: ${entry.topicKey}` : ''}
Tags: ${entry.tags.join(', ') || 'none'}

${entry.content}`
}

// ============================================
// Soft Delete
// ============================================

export function memDelete(memoryId: number, hard: boolean = false): boolean {
    const entry = store.entries.find(e => e.id === memoryId)
    if (!entry) return false

    if (hard) {
        store.entries = store.entries.filter(e => e.id !== memoryId)
    } else {
        entry.deletedAt = Date.now()
    }
    save()
    return true
}

// ============================================
// Session Summary (auto-generated)
// ============================================

export function memSessionSummary(sessionId: string): string {
    initProgressiveMemory()

    const sessionEntries = store.entries.filter(e => e.sessionId === sessionId && !e.deletedAt)
    if (sessionEntries.length === 0) return 'Keine Einträge in dieser Session.'

    const byType: Record<string, number> = {}
    for (const e of sessionEntries) {
        byType[e.type] = (byType[e.type] || 0) + 1
    }

    return `Session: ${sessionId}
Entries: ${sessionEntries.length}
Types: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(', ')}
Topics: ${sessionEntries.filter(e => e.topicKey).map(e => e.topicKey).join(', ')}

Recent:
${sessionEntries.slice(-5).map(e => `- ${e.type}: ${e.title}`).join('\n')}`
}

// ============================================
// Context Injection (for system prompt)
// ============================================

export function getMemoryContext(query: string, maxTokens: number = 500): string {
    initProgressiveMemory()

    const activeEntries = store.entries.filter(e => !e.deletedAt)
    if (activeEntries.length === 0) return ''

    // Auto-recall: get relevant memories for the query
    const relevant = memSearch(query, 5)
    if (relevant === 'Keine Erinnerungen gefunden.') return ''

    const tokenEstimate = Math.ceil(relevant.length / 3.5)
    if (tokenEstimate > maxTokens) {
        // Truncate to fit
        return `## PROGRESSIVE MEMORY (${activeEntries.length} entries)\n${relevant.slice(0, maxTokens * 3)}\nUse memRecall(id) for full content.`
    }

    return `## PROGRESSIVE MEMORY (${activeEntries.length} entries)\n${relevant}\nUse memRecall(id) for full content.`
}

// ============================================
// Stats
// ============================================

export function memStats(): string {
    initProgressiveMemory()

    const active = store.entries.filter(e => !e.deletedAt)
    const deleted = store.entries.filter(e => e.deletedAt)

    const byType: Record<string, number> = {}
    const byScope: Record<string, number> = {}
    for (const e of active) {
        byType[e.type] = (byType[e.type] || 0) + 1
        byScope[e.scope] = (byScope[e.scope] || 0) + 1
    }

    const topicKeys = active.filter(e => e.topicKey).length
    const multiRevision = active.filter(e => e.revisionCount > 1)

    return `📊 **Progressive Memory Stats**

Total: ${active.length} active, ${deleted.length} soft-deleted
Types: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(', ')}
Scopes: ${Object.entries(byScope).map(([s, c]) => `${s}(${c})`).join(', ')}
Topic-Keys: ${topicKeys}
Multi-Revision: ${multiRevision.length} entries
Dedup prevented: ${store.stats.deduplicationsPrevented}

Saves: ${store.stats.totalSaves} | Searches: ${store.stats.totalSearches} | Recalls: ${store.stats.totalRecalls}`
}

// ============================================
// Helpers
// ============================================

function formatAge(timestamp: number): string {
    const diff = Date.now() - timestamp
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}
