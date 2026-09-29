/**
 * The daemon's combined memory facade (local keyword + vector + LanceDB).
 * Extracted from daemon.ts so the principal scoping of recall is testable.
 */

import { principalScope } from '../users/principal-id.js'

export interface MemoryRecallAccess {
    /** Allowed LanceDB scopes, e.g. `user:<principal>` (+ legacy aliases) and `global`. */
    scopes?: string[]
    /** Legacy rows without a scope; only the owner may see them. */
    includeUnscoped?: boolean
}

interface RecallHit { content: string; score?: number; [key: string]: any }

export interface CombinedMemoryParts {
    local: { recall(query: string, userId: string, limit: number): Promise<RecallHit[]>; store(entry: any): Promise<unknown>; getStats(): any }
    vector: { recall(query: string, userId: string, limit: number): Promise<RecallHit[]>; store(entry: any): Promise<unknown>; getStats(): any }
    /** lancedb-memory default export, when loaded */
    getLance: () => { recall(query: string, limit: number, type?: any, access?: { scopes: string[]; includeUnscoped?: boolean }): Promise<any[]> } | undefined
}

/**
 * LanceDB is shared by all principals. Without an explicit access decision it
 * is searched fail-closed: only the caller's own scope and `global`, never
 * unscoped legacy rows (those are owner-only and need includeUnscoped: true).
 */
export function lanceAccessFor(userId: string, access?: MemoryRecallAccess): { scopes: string[]; includeUnscoped: boolean } {
    const own = String(userId || '').trim()
    const scopes = access?.scopes?.length
        ? [...new Set(access.scopes.map(scope => String(scope).trim()).filter(Boolean))]
        : [...(own ? [principalScope(own)] : []), 'global']
    return { scopes, includeUnscoped: access?.includeUnscoped === true }
}

export function createCombinedMemory(parts: CombinedMemoryParts) {
    return {
        recall: async (query: string, userId: string, limit: number, access?: MemoryRecallAccess) => {
            const vectorResults = await parts.vector.recall(query, userId, limit)
            const localResults = await parts.local.recall(query, userId, limit)

            let lanceResults: RecallHit[] = []
            try {
                const lance = parts.getLance()
                if (lance) {
                    const results = await lance.recall(query, limit, undefined, lanceAccessFor(userId, access))
                    lanceResults = results.map((r: any) => ({
                        content: r.entry?.content || r.content || '',
                        score: r.score || 0.5,
                    }))
                }
            } catch { /* lance optional */ }

            const seen = new Set<string>()
            const combined: RecallHit[] = []
            for (const r of [...vectorResults, ...localResults, ...lanceResults]) {
                const key = r.content.slice(0, 50)
                if (!seen.has(key)) {
                    seen.add(key)
                    combined.push(r)
                }
            }
            return combined.slice(0, limit)
        },
        // Store in local + vector. LanceDB storage is handled exclusively by
        // message-pipeline.ts (fact extraction, dedupe); writing it here
        // caused double-writes.
        store: async (entry: any) => {
            await parts.local.store(entry)
            await parts.vector.store(entry)
        },
        getStats: () => ({
            ...parts.local.getStats(),
            vectorStats: parts.vector.getStats(),
        }),
    }
}
