import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => new Map<string, { id: string; content: string; metadata: string }>())

vi.mock('@lancedb/lancedb', () => {
    const table = {
        countRows: async () => rows.size,
        search: () => {
            const query = { limit: () => query, where: () => query, toArray: async () => [] }
            return query
        },
        query: () => {
            let id = ''
            const query = {
                where: (filter: string) => { id = /id = '([^']*)'/.exec(filter)?.[1] || ''; return query },
                limit: () => query,
                toArray: async () => rows.has(id) ? [rows.get(id)] : [],
            }
            return query
        },
        add: async () => undefined,
        delete: async (filter: string) => { rows.delete(/id = '([^']*)'/.exec(filter)?.[1] || '') },
    }
    return { default: { connect: async () => ({ tableNames: async () => ['memories'], openTable: async () => table }) } }
})
vi.mock('./embedding-providers.js', () => ({
    embed: async () => ({ vector: [0.1, 0.2, 0.3], embedder: 'test:fest:3', provider: 'hash', model: 'fest', dimension: 3 }),
    parseEmbedderId: (id: string) => { const m = /^([a-z]+):(.+):(\d+)$/.exec(id || ''); return m ? { provider: m[1], model: m[2], dimension: Number(m[3]) } : null },
    resetEmbeddingDiscovery: () => undefined,
}))

const sandbox = join(process.cwd(), '.nova-test-tmp', `lance-forget-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
// Die Tabelle `memories` gehört genau einem Einbetter (2.84).
writeFileSync(join(sandbox, '.nova-data', 'lancedb-status.json'), JSON.stringify({ table: 'memories', embedder: 'test:fest:3', dimension: 3 }))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { forget } = await import('./lancedb-memory.js')

beforeEach(() => { rows.clear() })

// LanceDB ist eine knotenlokale Projektion; Vergessen über Knoten hinweg
// läuft über Governance-Tombstones (L22), nicht mehr über mesh-memory-sync.
describe('LanceDB forget()', () => {
    it('löscht den Eintrag lokal', async () => {
        rows.set('fact_1', { id: 'fact_1', content: 'Hinweis', metadata: JSON.stringify({ scope: 'global' }) })
        expect(await forget('fact_1')).toBe(true)
        expect(rows.has('fact_1')).toBe(false)
    })

    it('löscht auch, wenn die Metadaten unlesbar sind', async () => {
        rows.set('fact_3', { id: 'fact_3', content: 'x', metadata: '{not json' })
        expect(await forget('fact_3')).toBe(true)
        expect(rows.has('fact_3')).toBe(false)
    })
})
