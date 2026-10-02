import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildModelRegistry } from '../routing/model-registry.js'

// Punkt 2 (2.84): Gedächtnis-Einträge sind privat. Sie werden nur aus eigenen
// Quellen eingebettet (lokal, eigenes Mesh/Tailnet) — nie über eine Cloud-URL,
// auch nicht mit gesetztem OPENAI_API_KEY.
const calls: string[] = []
const fetchStub = vi.fn(async (url: string | URL) => {
    calls.push(String(url))
    // 2.86: aktuelle Ollama-API /api/embed (Antwort `embeddings`).
    if (String(url).endsWith('/api/embed')) {
        return new Response(JSON.stringify({ embeddings: [[0.5, 0.5, 0.5, 0.5]] }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })
})

const env = { openai: process.env.OPENAI_API_KEY, openrouter: process.env.OPENROUTER_API_KEY }
beforeEach(() => {
    calls.length = 0
    process.env.OPENAI_API_KEY = 'sk-test-nur-platzhalter'
    process.env.OPENROUTER_API_KEY = 'or-test-nur-platzhalter'
    vi.stubGlobal('fetch', fetchStub)
})
afterEach(() => {
    vi.unstubAllGlobals()
    if (env.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = env.openai
    if (env.openrouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = env.openrouter
})

const cloud = (url: string) => /api\.openai\.com|openrouter\.ai/.test(url)

describe('Einbettung nur aus eigenen Quellen', () => {
    it('Standard-Kette: kein Aufruf an eine Cloud-URL, Ergebnis ist ein Hash-Vektor', async () => {
        const { getEmbedding } = await import('./embedding-providers.js')
        const vector = await getEmbedding('Der Owner mag Kaffee ohne Zucker.', { localEndpoints: async () => [] } as any)
        expect(vector.length).toBe(768)
        expect(calls.filter(cloud)).toEqual([])
    })

    it('ohne lokalen Einbetter: Hash mit embedder hash, keine Cloud', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: async () => [] })
        expect(result?.provider).toBe('hash')
        expect(result?.embedder).toMatch(/^hash:/)
        expect(calls.filter(cloud)).toEqual([])
    })

    it('Gegenprobe: privat bleibt privat, auch wenn Cloud erlaubt und ein Key gesetzt ist', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: async () => [], allowCloud: true })
        expect(result?.provider).toBe('hash')
        expect(calls.filter(cloud)).toEqual([])
    })

    it('nimmt den eigenen Mesh-Einbetter (Ollama nomic-embed-text) und merkt sich das Modell', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', {
            localEndpoints: async () => [{ baseUrl: 'http://ns.example.com:11434', model: 'nomic-embed-text:latest', node: 'ns' }],
        })
        expect(calls).toEqual(['http://ns.example.com:11434/api/embed'])
        expect(result).toMatchObject({ provider: 'lokal', model: 'nomic-embed-text', dimension: 4, embedder: 'lokal:nomic-embed-text:4' })
    })

    it('fester Einbetter: fällt nicht still auf Hash zurück (keine gemischten Vektoren)', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: async () => [], only: 'lokal:nomic-embed-text:768' })
        expect(result).toBeNull()
        expect(calls).toEqual([])
    })

    it('Kandidaten nur aus dem Register: lokal, nicht down, Embedding-Modell', async () => {
        const { localEmbeddersFromRegistry } = await import('./embedding-providers.js') as any
        const registry = buildModelRegistry({
            knownNodes: ['ns'],
            ollama: [
                { node: 'ns', baseUrl: 'http://ns.example.com:11434', models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3.5:9b' }] },
                { baseUrl: 'http://198.51.100.7:11434', models: [{ name: 'nomic-embed-text:latest' }] },
            ],
        })
        expect(localEmbeddersFromRegistry(registry)).toEqual([
            { baseUrl: 'http://ns.example.com:11434', model: 'nomic-embed-text:latest', node: 'ns' },
        ])
    })
})
