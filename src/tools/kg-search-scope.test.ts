import { describe, expect, it, vi } from 'vitest'

// INT-10 regression: the kg_search tool searched the knowledge graph without
// any principal scope. Non-owners now only see their own scope and global.

const kg = vi.hoisted(() => ({ searchGraph: vi.fn((..._args: any[]) => 'hit') }))
vi.mock('../memory/knowledge-graph.js', () => ({ searchGraph: kg.searchGraph }))
vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getUserPermission: (id: string) => id === '111' ? 'owner' : 'user',
}))

import { ALL_TOOLS, kgSearchScopes } from './complete-registry.js'

const kgSearch = () => ALL_TOOLS.find(tool => tool.name === 'kg_search')!

describe('kg_search is principal-scoped (INT-10)', () => {
    it('passes the requester scopes for a non-owner', async () => {
        await kgSearch().handler({ query: 'Tresor', userId: 'bob', authorizationUserId: '222', channel: 'telegram' })
        expect(kg.searchGraph).toHaveBeenLastCalledWith('Tresor', 6, ['user:bob', 'user:222', 'global'])
    })

    it('searches all scopes only for the owner', async () => {
        await kgSearch().handler({ query: 'Tresor', userId: 'alfred', authorizationUserId: '111', channel: 'telegram' })
        expect(kg.searchGraph).toHaveBeenLastCalledWith('Tresor', 6, undefined)
    })

    it('falls back to global only without any identity', async () => {
        expect(await kgSearchScopes({})).toEqual(['global'])
    })
})
