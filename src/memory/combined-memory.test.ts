import { describe, expect, it, vi } from 'vitest'
import { createCombinedMemory, lanceAccessFor } from './combined-memory.js'

// INT-3b regression: the daemon's state.memory.recall searched the shared
// LanceDB store without any scope, so any principal could recall owner facts.

function parts() {
    const lanceRecall = vi.fn(async (..._args: any[]) => [{ entry: { content: 'lance fact' }, score: 0.9 }])
    return {
        lanceRecall,
        memory: createCombinedMemory({
            local: { recall: vi.fn(async () => []), store: vi.fn(async () => undefined), getStats: () => ({}) },
            vector: { recall: vi.fn(async () => []), store: vi.fn(async () => undefined), getStats: () => ({}) },
            getLance: () => ({ recall: lanceRecall }),
        }),
    }
}

describe('combined memory recall is principal-scoped (INT-3b)', () => {
    it('passes the caller\'s scopes and owner decision to LanceDB', async () => {
        const { memory, lanceRecall } = parts()
        const result = await memory.recall('farbe', 'alice', 3, { scopes: ['user:alice', 'user:tg-1', 'global'], includeUnscoped: true })
        expect(lanceRecall).toHaveBeenCalledWith('farbe', 3, undefined, { scopes: ['user:alice', 'user:tg-1', 'global'], includeUnscoped: true })
        expect(result.map(r => r.content)).toEqual(['lance fact'])
    })

    it('defaults to the caller\'s own scope + global and never unscoped rows', async () => {
        const { memory, lanceRecall } = parts()
        await memory.recall('farbe', 'guest-7', 3)
        expect(lanceRecall).toHaveBeenCalledWith('farbe', 3, undefined, { scopes: ['user:guest-7', 'global'], includeUnscoped: false })
    })

    it('does not grant unscoped access unless explicitly true', () => {
        expect(lanceAccessFor('bob', { scopes: ['user:bob'], includeUnscoped: 'yes' as any })).toEqual({ scopes: ['user:bob'], includeUnscoped: false })
        expect(lanceAccessFor('', undefined)).toEqual({ scopes: ['global'], includeUnscoped: false })
    })
})
