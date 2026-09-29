import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => [] as Array<{ content: string; type: string; source: string }>)

vi.mock('@lancedb/lancedb', () => {
    const table = {
        countRows: async () => 0,
        search: () => {
            const query = { limit: () => query, where: () => query, toArray: async () => [] }
            return query
        },
        add: async () => undefined,
        delete: async () => undefined,
    }
    return { default: { connect: async () => ({ tableNames: async () => ['memories'], openTable: async () => table }) } }
})
vi.mock('./embedding-providers.js', () => ({ getEmbedding: async () => [0.1, 0.2, 0.3] }))
vi.mock('../mesh/mesh-memory-sync.js', () => ({
    shareMemory: async (content: string, type: string, source: string) => { shared.push({ content, type, source }) },
}))

const sandbox = join(process.cwd(), '.nova-test-tmp', `lance-mesh-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { remember } = await import('./lancedb-memory.js')

// shareMemory is fired without await inside remember(); let the import settle.
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => { shared.length = 0 })

describe('LanceDB remember() mesh distribution (R2 MA-4)', () => {
    it('never shares a principal-scoped owner fact to the mesh', async () => {
        expect(await remember('Alfreds Tresor-PIN liegt im Keller', 'fact', 'governance:test', { scope: 'user:owner' })).toBeTruthy()
        await settle()
        expect(shared).toEqual([])
    })

    it('never shares unscoped entries such as document chunks', async () => {
        await remember('Dokument: password=hunter2hunter2', 'document', 'document-rag', { filePath: '/x' })
        await settle()
        expect(shared).toEqual([])
    })

    it('does not share global entries without explicit opt-in', async () => {
        await remember('Der Spark hat 128 GB RAM', 'fact', 'governance:test', { scope: 'global' })
        await settle()
        expect(shared).toEqual([])
    })

    it('shares explicitly opted-in global entries, redacted', async () => {
        await remember('Mesh-Hinweis token=abcdefgh12345678', 'fact', 'governance:test', { scope: 'global', meshShare: true })
        await settle()
        expect(shared).toHaveLength(1)
        expect(shared[0].content).not.toContain('abcdefgh12345678')
    })
})
