import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import lancedb from '@lancedb/lancedb'

// Punkt 2 (2.84): getStats() zählte mit countRows() und warf das Ergebnis weg,
// weil danach table.search([]) immer scheitert — der Start meldete stets
// „0 Einträge“. Echte LanceDB im Temp-Ordner, nur der Einbetter ist gestellt.
const fake = vi.hoisted(() => ({ localUp: false }))
vi.mock('./embedding-providers.js', async importOriginal => {
    const original = await importOriginal<typeof import('./embedding-providers.js')>()
    const local = { vector: [0.1, 0.2, 0.3], embedder: 'lokal:nomic-embed-text:3', provider: 'lokal', model: 'nomic-embed-text', dimension: 3 }
    const hash = { vector: [0.3, 0.2, 0.1], embedder: 'hash:v1:3', provider: 'hash', model: 'v1', dimension: 3 }
    const fixed = { vector: [0.1, 0.2, 0.3], embedder: 'test:fest:3', provider: 'hash', model: 'fest', dimension: 3 }
    return {
        ...original,
        resetEmbeddingDiscovery: () => undefined,
        embed: async (_text: string, options: { only?: string } = {}) => {
            if (options.only === fixed.embedder) return fixed
            if (options.only === local.embedder) return fake.localUp ? local : null
            if (options.only === hash.embedder) return hash
            if (options.only) return null
            return fake.localUp ? local : hash
        },
    }
})

const cwd = vi.spyOn(process, 'cwd')
afterAll(() => cwd.mockRestore())

function sandbox(name: string): string {
    const dir = join(process.cwd(), '.nova-test-tmp', `${name}-${randomUUID()}`)
    mkdirSync(join(dir, '.nova-data'), { recursive: true })
    return dir
}

describe('LanceDB-Zählung', () => {
    it('zählt die echten Zeilen statt 0, je Typ und im Zeitfenster', async () => {
        const dir = sandbox('lance-zaehlung')
        const now = Date.now()
        const db = await lancedb.connect(join(dir, '.nova-data', 'lancedb'))
        await db.createTable('memories', [
            { id: 'a', content: 'eins', embedding: [0.1, 0.2, 0.3], type: 'fact', source: 'test', timestamp: now - 1_000, metadata: '{}' },
            { id: 'b', content: 'zwei', embedding: [0.2, 0.2, 0.3], type: 'learning', source: 'test', timestamp: now - 2_000, metadata: '{}' },
            { id: 'c', content: 'drei', embedding: [0.3, 0.2, 0.3], type: 'learning', source: 'test', timestamp: now - 20 * 86_400_000, metadata: '{}' },
        ])
        // Die Tabelle gehört zu genau einem Einbetter (ein Vektorraum je Tabelle).
        writeFileSync(join(dir, '.nova-data', 'lancedb-status.json'), JSON.stringify({ initialized: true, table: 'memories', embedder: 'test:fest:3', dimension: 3 }))
        cwd.mockReturnValue(dir)
        vi.resetModules()
        const lance = await import('./lancedb-memory.js')

        const stats = await lance.getStats()
        expect(stats.totalEntries).toBe(3)
        expect(stats.byType).toEqual({ fact: 1, learning: 2 })
        expect((stats as any).error).toBeUndefined()
        expect(await (lance as any).countRowsBetween(now - 7 * 86_400_000, now)).toBe(2)
    })
})

describe('Ein Vektorraum je Tabelle', () => {
    it('Hash -> eigener Einbetter: neue Tabelle; gebundener Einbetter weg: erst nach 24 h zurück', async () => {
        const dir = sandbox('lance-wechsel')
        cwd.mockReturnValue(dir)
        vi.resetModules()
        fake.localUp = false
        const lance: any = await import('./lancedb-memory.js')

        expect(await lance.remember('Der Owner mag Kaffee.', 'fact', 'test', { scope: 'user:owner' })).toBeTruthy()
        expect(lance.getActiveProjection()).toMatchObject({ embedder: 'hash:v1:3', table: 'memories_hash_v1_3' })
        const row = (await (await (await lancedb.connect(join(dir, '.nova-data', 'lancedb'))).openTable('memories_hash_v1_3')).query().toArray())[0]
        expect(JSON.parse(row.metadata).embedder).toBe('hash:v1:3')

        fake.localUp = true
        const now = Date.now()
        expect(await lance.reconcileEmbedder(now)).toMatchObject({ switched: true, from: 'hash:v1:3', to: 'lokal:nomic-embed-text:3' })
        expect((await lance.getStats()).totalEntries).toBe(0) // neue Tabelle, Neuaufbau über die Governance
        expect(await lance.remember('Die Katze heißt Minka.', 'fact', 'test', {})).toBeTruthy()

        // Eigener Einbetter fällt aus: kein stiller Hash-Eintrag in der Lokal-Tabelle.
        fake.localUp = false
        expect(await lance.remember('Neuer Eintrag ohne Einbetter.', 'fact', 'test', {})).toBeNull()
        expect(await lance.reconcileEmbedder(now + 60_000)).toMatchObject({ switched: false })
        expect(await lance.reconcileEmbedder(now + 25 * 60 * 60_000)).toMatchObject({ switched: true, to: 'hash:v1:3' })
        const status = JSON.parse(readFileSync(join(dir, '.nova-data', 'lancedb-status.json'), 'utf8'))
        expect(status).toMatchObject({ table: 'memories_hash_v1_3', embedder: 'hash:v1:3' })
        expect((await lance.getStats()).totalEntries).toBe(1)
    })
})
