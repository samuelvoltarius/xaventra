import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@lancedb/lancedb', () => {
    const table = {
        countRows: async () => rows.length,
        search: () => {
            const query = {
                limit: () => query,
                where: () => query,
                toArray: async () => rows.map(row => ({ ...row, _distance: 0.1 })),
            }
            return query
        },
        add: async () => undefined,
        delete: async () => undefined,
    }
    return { default: { connect: async () => ({ tableNames: async () => ['memories'], openTable: async () => table }) } }
})
vi.mock('./embedding-providers.js', () => ({
    embed: async () => ({ vector: [0.1, 0.2, 0.3], embedder: 'test:fest:3', provider: 'hash', model: 'fest', dimension: 3 }),
    parseEmbedderId: (id: string) => { const m = /^([a-z]+):(.+):(\d+)$/.exec(id || ''); return m ? { provider: m[1], model: m[2], dimension: Number(m[3]) } : null },
    resetEmbeddingDiscovery: () => undefined,
}))
vi.mock('./memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => ({ isRecallable: () => true }) }))

const sandbox = join(process.cwd(), '.nova-test-tmp', `lance-scope-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
// Die Tabelle `memories` gehört genau einem Einbetter (2.84).
writeFileSync(join(sandbox, '.nova-data', 'lancedb-status.json'), JSON.stringify({ table: 'memories', embedder: 'test:fest:3', dimension: 3 }))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { recall } = await import('./lancedb-memory.js')

function row(id: string, content: string, metadata: Record<string, unknown>) {
    return { id, content, type: 'fact', source: 'test', timestamp: Date.now(), metadata: JSON.stringify(metadata) }
}

rows.push(
    row('owner', 'Der Server Passwort-Tresor steht im Keller des Owners', { scope: 'user:owner' }),
    row('guest', 'Der Gast mag den Server im Keller', { scope: 'user:guest' }),
    row('global', 'Der Server im Keller ist ein Spark', { scope: 'global' }),
    row('legacy', 'Legacy: Server im Keller ohne Scope', {}),
)

describe('LanceDB recall scope filtering (H7)', () => {
    it('returns only the principal\'s own and global entries for a non-owner', async () => {
        const results = await recall('Server Keller', 10, undefined, { scopes: ['user:guest', 'global'], includeUnscoped: false })
        expect(results.map(result => result.entry.id).sort()).toEqual(['global', 'guest'])
    })

    it('includes legacy entries without scope only for the owner', async () => {
        const results = await recall('Server Keller', 10, undefined, { scopes: ['user:owner', 'global'], includeUnscoped: true })
        expect(results.map(result => result.entry.id).sort()).toEqual(['global', 'legacy', 'owner'])
    })

    it('fails closed for an empty scope list', async () => {
        const results = await recall('Server Keller', 10, undefined, { scopes: [], includeUnscoped: false })
        expect(results).toEqual([])
    })
})
