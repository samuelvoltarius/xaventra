import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Paket G (2.86): die 2.84-Regel „ein Vektorraum je Tabelle, Wechsel nur zu
// einem besseren Einbetter oder nach 24 h Ausfall, dann Neu-Projektion“ gilt
// auch für den eigenen In-Prozess-Einbetter. Rangfolge: eigen > lokal > Hash.
// Echte LanceDB im Temp-Ordner, nur der Einbetter ist gestellt.
const fake = vi.hoisted(() => ({ eigenUp: false, lokalUp: true }))
vi.mock('./embedding-providers.js', async importOriginal => {
    const original = await importOriginal<typeof import('./embedding-providers.js')>()
    const eigen = { vector: [0.1, 0.2, 0.3, 0.4], embedder: 'eigen:qwen3-embedding-0.6b-q8_0:4', provider: 'eigen', model: 'qwen3-embedding-0.6b-q8_0', dimension: 4 }
    const lokal = { vector: [0.1, 0.2, 0.3], embedder: 'lokal:nomic-embed-text:3', provider: 'lokal', model: 'nomic-embed-text', dimension: 3 }
    const hash = { vector: [0.3, 0.2, 0.1], embedder: 'hash:v1:3', provider: 'hash', model: 'v1', dimension: 3 }
    return {
        ...original,
        resetEmbeddingDiscovery: () => undefined,
        embed: async (_text: string, options: { only?: string } = {}) => {
            if (options.only === eigen.embedder) return fake.eigenUp ? eigen : null
            if (options.only === lokal.embedder) return fake.lokalUp ? lokal : null
            if (options.only === hash.embedder) return hash
            if (options.only) return null
            return fake.eigenUp ? eigen : fake.lokalUp ? lokal : hash
        },
    }
})

const cwd = vi.spyOn(process, 'cwd')
afterAll(() => cwd.mockRestore())

describe('Ein Vektorraum je Tabelle — auch für den eigenen Einbetter', () => {
    it('Mesh-Ollama -> eigenes Modell ist besser: neue Tabelle; eigenes weg: erst nach 24 h zurück zu Ollama', async () => {
        const dir = join(process.cwd(), '.nova-test-tmp', `lance-eigen-${randomUUID()}`)
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        cwd.mockReturnValue(dir)
        vi.resetModules()
        fake.eigenUp = false
        fake.lokalUp = true
        const lance: any = await import('./lancedb-memory.js')

        expect(await lance.remember('Der Owner mag Kaffee.', 'fact', 'test', {})).toBeTruthy()
        expect(lance.getActiveProjection()).toMatchObject({ embedder: 'lokal:nomic-embed-text:3' })

        fake.eigenUp = true
        const now = Date.now()
        expect(await lance.reconcileEmbedder(now)).toMatchObject({ switched: true, from: 'lokal:nomic-embed-text:3', to: 'eigen:qwen3-embedding-0.6b-q8_0:4', reason: 'besser' })
        expect(lance.getActiveProjection()).toMatchObject({ table: 'memories_eigen_qwen3-embedding-0_6b-q8_0_4' })
        expect((await lance.getStats()).totalEntries).toBe(0) // Neuaufbau über die Governance
        expect(await lance.remember('Die Katze heißt Minka.', 'fact', 'test', {})).toBeTruthy()

        // Eigener Einbetter kurz weg: kein stiller Ollama-Eintrag, kein Wechsel.
        fake.eigenUp = false
        expect(await lance.remember('Neuer Eintrag ohne Einbetter.', 'fact', 'test', {})).toBeNull()
        expect(await lance.reconcileEmbedder(now + 60_000)).toMatchObject({ switched: false })
        expect(await lance.reconcileEmbedder(now + 25 * 60 * 60_000)).toMatchObject({ switched: true, to: 'lokal:nomic-embed-text:3', reason: 'nicht erreichbar' })
    })

    it('eigenes Modell gebunden, Ollama taucht auf: kein Wechsel (nicht besser)', async () => {
        const dir = join(process.cwd(), '.nova-test-tmp', `lance-eigen-${randomUUID()}`)
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        cwd.mockReturnValue(dir)
        vi.resetModules()
        fake.eigenUp = true
        fake.lokalUp = false
        const lance: any = await import('./lancedb-memory.js')
        expect(await lance.remember('Der Owner mag Tee.', 'fact', 'test', {})).toBeTruthy()
        fake.lokalUp = true
        expect(await lance.reconcileEmbedder(Date.now())).toMatchObject({ switched: false })
        expect(lance.getActiveProjection()).toMatchObject({ embedder: 'eigen:qwen3-embedding-0.6b-q8_0:4' })
    })
})
