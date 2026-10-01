import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryFacade, lanceAccessFor } from './memory-facade.js'
import { MemoryGovernanceCoordinator } from './memory-governance.js'

// state.memory liest nur noch Governance + LanceDB (keine .nova-memory /
// .nova-vector-memory mehr). INT-3b bleibt: der Abruf ist principal-scoped.
function parts() {
    const governance = new MemoryGovernanceCoordinator(join(mkdtempSync(join(process.cwd(), '.nova-test-tmp', 'facade-')), 'governance'))
    governance.propose({ content: 'Alice bevorzugt eine dunkle Oberfläche in allen Programmen.', kind: 'preference', scope: 'user:alice', source: 'test', evidence: 'explicit_user_instruction', confidence: 1 })
    governance.propose({ content: 'Bob bevorzugt eine helle Oberfläche in allen Programmen.', kind: 'preference', scope: 'user:bob', source: 'test', evidence: 'explicit_user_instruction', confidence: 1 })
    const lanceRecall = vi.fn(async (..._args: any[]) => [{ entry: { content: 'lance fact' }, score: 0.9 }])
    return { lanceRecall, memory: createMemoryFacade({ getLance: () => ({ recall: lanceRecall, getStats: async () => ({ totalEntries: 7 }) }), governance: () => governance }) }
}

describe('state.memory: Governance + LanceDB, principal-scoped (INT-3b)', () => {
    it('übergibt Scopes und Owner-Entscheidung an LanceDB und liefert eigene Governance-Treffer zuerst', async () => {
        const { memory, lanceRecall } = parts()
        const result = await memory.recall('Oberfläche', 'alice', 3, { scopes: ['user:alice', 'user:tg-1', 'global'], includeUnscoped: true })
        expect(lanceRecall).toHaveBeenCalledWith('Oberfläche', 3, undefined, { scopes: ['user:alice', 'user:tg-1', 'global'], includeUnscoped: true })
        expect(result.map(hit => hit.content)).toEqual(['Alice bevorzugt eine dunkle Oberfläche in allen Programmen.', 'lance fact'])
    })

    it('Gegenprobe: ohne Freigabe nur eigener Scope + global, nie fremde oder unscoped Einträge', async () => {
        const { memory, lanceRecall } = parts()
        const result = await memory.recall('Oberfläche', 'guest-7', 3)
        expect(lanceRecall).toHaveBeenCalledWith('Oberfläche', 3, undefined, { scopes: ['user:guest-7', 'global'], includeUnscoped: false })
        expect(result.map(hit => hit.content)).toEqual(['lance fact'])
    })

    it('gewährt unscoped Zugriff nur bei ausdrücklichem true', () => {
        expect(lanceAccessFor('bob', { scopes: ['user:bob'], includeUnscoped: 'yes' as any })).toEqual({ scopes: ['user:bob'], includeUnscoped: false })
        expect(lanceAccessFor('', undefined)).toEqual({ scopes: ['global'], includeUnscoped: false })
    })

    it('Statistik kommt aus der Governance, LanceDB-Zahl separat', async () => {
        const { memory } = parts()
        expect(memory.getStats()).toMatchObject({ totalEntries: 2, uniqueUsers: 2, canonical: 2 })
        expect(await memory.getLanceEntries()).toBe(7)
        expect('store' in memory).toBe(false)
    })
})
