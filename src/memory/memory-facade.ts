/**
 * `state.memory`: the read side of the one memory authority.
 *
 * Memory governance holds the records; LanceDB is its semantic projection.
 * The former local keyword store (.nova-memory) and vector store
 * (.nova-vector-memory) are gone — their files are migrated once at start
 * (legacy-memory-migration.ts). Nothing writes through this facade: writes go
 * to governance from their sources (observer, distiller, corrections,
 * kg_remember, /memory approve).
 */

import { principalScope } from '../users/principal-id.js'
import { getMemoryGovernanceCoordinator, type MemoryGovernanceCoordinator } from './memory-governance.js'

export interface MemoryRecallAccess {
    /** Allowed scopes, e.g. `user:<principal>` (+ legacy aliases) and `global`. */
    scopes?: string[]
    /** Legacy LanceDB rows without a scope; only the owner may see them. */
    includeUnscoped?: boolean
}

export interface MemoryHit { content: string; score: number; source: 'governance' | 'lancedb' }

interface LanceLike {
    recall(query: string, limit: number, type?: any, access?: { scopes: string[]; includeUnscoped?: boolean }): Promise<any[]>
    getStats?(): Promise<{ totalEntries: number }>
}

export interface MemoryFacadeParts {
    /** lancedb-memory default export, when loaded */
    getLance: () => LanceLike | undefined
    governance?: () => MemoryGovernanceCoordinator
}

/**
 * Scopes are fail-closed: without an explicit access decision only the
 * caller's own scope and `global` are searched, never unscoped legacy rows
 * (those are owner-only and need includeUnscoped: true).
 */
export function lanceAccessFor(userId: string, access?: MemoryRecallAccess): { scopes: string[]; includeUnscoped: boolean } {
    const own = String(userId || '').trim()
    const scopes = access?.scopes?.length
        ? [...new Set(access.scopes.map(scope => String(scope).trim()).filter(Boolean))]
        : [...(own ? [principalScope(own)] : []), 'global']
    return { scopes, includeUnscoped: access?.includeUnscoped === true }
}

export function createMemoryFacade(parts: MemoryFacadeParts) {
    const governance = parts.governance || getMemoryGovernanceCoordinator
    return {
        /** Governed records first (verified/canonical), then LanceDB hits; principal-scoped. */
        recall: async (query: string, userId: string, limit: number, access?: MemoryRecallAccess): Promise<MemoryHit[]> => {
            const allowed = lanceAccessFor(userId, access)
            const hits: MemoryHit[] = governance().recall(allowed.scopes, query, limit)
                .map(record => ({ content: record.content, score: record.confidence, source: 'governance' as const }))
            try {
                const lance = parts.getLance()
                if (lance) {
                    for (const row of await lance.recall(query, limit, undefined, allowed)) {
                        const content = String(row?.entry?.content || row?.content || '')
                        if (content) hits.push({ content, score: Number(row?.score) || 0.5, source: 'lancedb' })
                    }
                }
            } catch { /* LanceDB is an optional projection */ }
            const seen = new Set<string>()
            return hits.filter(hit => {
                const key = hit.content.slice(0, 80)
                if (seen.has(key)) return false
                seen.add(key)
                return true
            }).slice(0, limit)
        },
        /** Counts from governance (synchronous). */
        getStats: () => {
            const records = governance().list()
            const active = records.filter(record => record.status === 'verified' || record.status === 'canonical')
            const stats = governance().getStats()
            return {
                totalEntries: active.length,
                uniqueUsers: new Set(active.filter(record => record.scope.startsWith('user:')).map(record => record.scope)).size,
                canonical: stats.canonical,
                verified: stats.verified,
                candidate: stats.candidate,
            }
        },
        /** Rows in the LanceDB projection (null when LanceDB is not loaded). */
        getLanceEntries: async (): Promise<number | null> => {
            try {
                const lance = parts.getLance()
                return lance?.getStats ? (await lance.getStats()).totalEntries : null
            } catch { return null }
        },
    }
}

export type MemoryFacade = ReturnType<typeof createMemoryFacade>
