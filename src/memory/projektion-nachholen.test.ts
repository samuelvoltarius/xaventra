import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Punkt 2 (2.84): publish() versuchte die LanceDB-Projektion genau einmal und
// schluckte den Fehler. Einträge ohne Projektion werden jetzt nachgetragen,
// und nach einem Wechsel des Einbetters neu projiziert (nie gemischt).
const lance = vi.hoisted(() => ({
    fail: true,
    table: 'memories_neu',
    remembered: [] as Array<{ content: string; timestamp?: number }>,
    forgotten: [] as Array<{ id: string; table?: string }>,
}))
vi.mock('./lancedb-memory.js', () => ({
    remember: async (content: string, _type: string, _source: string, _meta: unknown, options?: { timestamp?: number }) => {
        if (lance.fail) return null
        lance.remembered.push({ content, timestamp: options?.timestamp })
        return `fact_${lance.remembered.length}`
    },
    forget: async (id: string, table?: string) => { lance.forgotten.push({ id, table }); return true },
    getActiveProjection: () => ({ table: lance.table, embedder: 'lokal:nomic-embed-text:768' }),
    reconcileEmbedder: async () => ({ switched: false }),
}))
vi.mock('../layers/L6-core-facts.js', () => ({ addFact: () => undefined }))

const { MemoryGovernanceCoordinator } = await import('./memory-governance.js')

const env = { test: process.env.NOVA_TEST_MODE, side: process.env.NOVA_NO_SIDE_EFFECTS }
beforeEach(() => {
    lance.fail = true; lance.table = 'memories_neu'; lance.remembered.length = 0; lance.forgotten.length = 0
    delete process.env.NOVA_TEST_MODE; delete process.env.NOVA_NO_SIDE_EFFECTS
})
afterEach(() => { process.env.NOVA_TEST_MODE = env.test; process.env.NOVA_NO_SIDE_EFFECTS = env.side })

function governance(): any {
    return new MemoryGovernanceCoordinator(join(process.cwd(), '.nova-test-tmp', `projektion-${randomUUID()}`))
}

async function canonical(g: any, content: string): Promise<string> {
    const record = await g.record({ content, kind: 'context', scope: 'user:owner', source: 'test', evidence: 'explicit_user_instruction', confidence: 1, verified: true }, { publish: false })
    g.approve(record.id, 'test')
    return record.id
}

describe('Projektion nachtragen', () => {
    it('Eintrag ohne lancedbId bekommt sie im Wartungslauf, wenn LanceDB wieder heil ist', async () => {
        const g = governance()
        const id = await canonical(g, 'Der Owner arbeitet am liebsten morgens an Xaventra.')
        await g.publish(id)
        expect(g.list().find((item: any) => item.id === id)?.backends.lancedbId).toBeUndefined()

        lance.fail = false
        const report = await g.backfillProjections({ limit: 200 })
        const record = g.list().find((item: any) => item.id === id)
        expect(record.backends.lancedbId).toBe('fact_1')
        expect(record.backends.lancedbTable).toBe('memories_neu')
        expect(report).toMatchObject({ projected: 1, failed: 0, pending: 0 })
        // Ursprungszeit bleibt (Zeitverfall im Abruf und Lern-Puls zählen richtig).
        expect(lance.remembered[0].timestamp).toBe(record.createdAt)
    })

    it('nach Einbetter-Wechsel neu projizieren und die alte Zeile entfernen', async () => {
        const g = governance()
        lance.fail = false
        lance.table = 'memories'
        const id = await canonical(g, 'Der Owner trinkt Kaffee ohne Zucker am Nachmittag.')
        await g.publish(id)
        expect(g.list().find((item: any) => item.id === id)?.backends.lancedbTable).toBe('memories')

        lance.table = 'memories_lokal_nomic-embed-text_768'
        expect((await g.projectionStatus()).stale).toBe(1)
        const report = await g.backfillProjections({ limit: 200 })
        expect(report.projected).toBe(1)
        expect(lance.forgotten).toEqual([{ id: 'fact_1', table: 'memories' }])
        expect(g.list().find((item: any) => item.id === id)?.backends.lancedbTable).toBe('memories_lokal_nomic-embed-text_768')
    })

    it('begrenzt je Lauf und meldet den Rest', async () => {
        const g = governance()
        for (const text of ['Der Owner fährt im Winter gern Ski in Tirol.', 'Die Katze des Owners heißt Minka.', 'Der Owner hört beim Arbeiten Jazz.']) await canonical(g, text)
        lance.fail = false
        const report = await g.backfillProjections({ limit: 2 })
        expect(report).toMatchObject({ projected: 2, pending: 1 })
        expect((await g.projectionStatus()).missing).toBe(1)
    })

    it('Kandidaten werden nie projiziert', async () => {
        const g = governance()
        await g.record({ content: 'Vielleicht mag der Owner Tee lieber als Kaffee.', kind: 'context', scope: 'user:owner', source: 'test', evidence: 'inferred', confidence: 0.3 }, { publish: false })
        lance.fail = false
        const report = await g.backfillProjections({ limit: 200 })
        expect(report.projected).toBe(0)
        expect(lance.remembered).toEqual([])
    })
})
