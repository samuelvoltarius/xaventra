import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => new Map<string, { id: string; content: string; metadata: string }>())
const forgotten = vi.hoisted(() => [] as Array<{ match: unknown; options: unknown }>)

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
vi.mock('./embedding-providers.js', () => ({ getEmbedding: async () => [0.1, 0.2, 0.3] }))
vi.mock('../mesh/mesh-memory-sync.js', () => ({
    shareMemory: async () => undefined,
    forgetSharedMemory: async (match: unknown, options: unknown) => { forgotten.push({ match, options }); return 1 },
}))

const sandbox = join(process.cwd(), '.nova-test-tmp', `lance-forget-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { forget } = await import('./lancedb-memory.js')

beforeEach(() => { rows.clear(); forgotten.length = 0 })

describe('LanceDB forget() also removes the mesh copy (UEB-17)', () => {
    it('broadcasts a forget for a shared global entry, with the redacted content', async () => {
        rows.set('fact_1', { id: 'fact_1', content: 'Mesh-Hinweis token=abcdefgh12345678', metadata: JSON.stringify({ scope: 'global', meshShare: true }) })
        expect(await forget('fact_1')).toBe(true)
        expect(rows.has('fact_1')).toBe(false)
        expect(forgotten).toHaveLength(1)
        expect(JSON.stringify(forgotten[0].match)).not.toContain('abcdefgh12345678')
        expect(forgotten[0].options).toEqual({ broadcast: true })
    })

    it('does not touch the mesh for a private entry', async () => {
        rows.set('fact_2', { id: 'fact_2', content: 'Alfreds PIN', metadata: JSON.stringify({ scope: 'user:owner' }) })
        expect(await forget('fact_2')).toBe(true)
        expect(forgotten).toEqual([])
    })

    it('still deletes locally when the row cannot be read', async () => {
        rows.set('fact_3', { id: 'fact_3', content: 'x', metadata: '{not json' })
        expect(await forget('fact_3')).toBe(true)
        expect(rows.has('fact_3')).toBe(false)
        expect(forgotten).toEqual([])
    })
})
