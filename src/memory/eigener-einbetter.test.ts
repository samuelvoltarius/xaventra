import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildModelRegistry } from '../routing/model-registry.js'

// Paket G (2.86, Alfred 02.10.): „lass sie doch ihr eigenes Embedding-Modell
// mitbringen, llama.cpp hat sie ja eh schon“. Ein kleines GGUF-Modell läuft im
// Prozess über node-llama-cpp (CPU, GPU optional). Feste Rangfolge:
// eigenes In-Prozess-Modell > eigenes Mesh-Ollama-Modell > Hash. Nie Cloud für
// Privates. Kein Netz, kein Modell-Download in diesen Tests: die Engine ist
// gestellt, Ollama über ein eingespritztes fetch.

const calls: Array<{ url: string; body: any }> = []
let ollamaNewApi = true
const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (href.endsWith('/api/embed')) {
        if (!ollamaNewApi) return new Response('404 page not found', { status: 404 })
        return new Response(JSON.stringify({ model: 'x', embeddings: [[0.5, 0.5, 0.5, 0.5]] }), { status: 200 })
    }
    if (href.endsWith('/api/embeddings')) return new Response(JSON.stringify({ embedding: [0.25, 0.25, 0.25, 0.25] }), { status: 200 })
    return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })
})

const env = { openai: process.env.OPENAI_API_KEY }
beforeEach(() => {
    calls.length = 0
    ollamaNewApi = true
    process.env.OPENAI_API_KEY = 'sk-test-nur-platzhalter'
    vi.stubGlobal('fetch', fetchStub)
})
afterEach(() => {
    vi.unstubAllGlobals()
    if (env.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = env.openai
})

const MODEL = 'qwen3-embedding-0.6b-q8_0'
const vec1024 = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7)
const eigen = (up = true) => async () => up ? { model: MODEL, embed: async () => vec1024 } : null
const ollama = async () => [{ baseUrl: 'http://ns.example.com:11434', model: 'nomic-embed-text:latest', node: 'ns' }]
const testArtifact = (bytes: Buffer) => ({
    name: 'test-embed', filename: 'test-embed.gguf', url: 'https://example.com/test-embed.gguf', sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), dimension: 4, license: 'Apache-2.0', releasedAt: '2025-06',
})

describe('Eigener Einbetter im Prozess (node-llama-cpp)', () => {
    it('ohne Ollama: nimmt das eigene GGUF-Modell statt Hash', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: async () => [], inProcess: eigen() })
        expect(result).toMatchObject({ provider: 'eigen', model: MODEL, dimension: 1024, embedder: `eigen:${MODEL}:1024` })
        expect(calls).toEqual([])
    })

    it('feste Rangfolge: eigenes Modell vor Mesh-Ollama, Ollama vor Hash', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        expect((await embed('x', { localEndpoints: ollama, inProcess: eigen() }))?.provider).toBe('eigen')
        expect(calls).toEqual([])
        expect((await embed('x', { localEndpoints: ollama, inProcess: eigen(false) }))?.provider).toBe('lokal')
        expect((await embed('x', { localEndpoints: async () => [], inProcess: eigen(false) }))?.provider).toBe('hash')
    })

    it('Tabellenbindung: `only` bleibt beim gebundenen Vektorraum, kein stiller Wechsel', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const lokal = await embed('x', { localEndpoints: ollama, inProcess: eigen(), only: 'lokal:nomic-embed-text:4' })
        expect(lokal?.embedder).toBe('lokal:nomic-embed-text:4')
        expect(await embed('x', { localEndpoints: ollama, inProcess: eigen(false), only: `eigen:${MODEL}:1024` })).toBeNull()
        expect(await embed('x', { localEndpoints: ollama, inProcess: eigen(), only: `eigen:${MODEL}:768` })).toBeNull()
        expect(await embed('x', { localEndpoints: ollama, inProcess: eigen(), only: 'eigen:anderes-modell:1024' })).toBeNull()
        expect((await embed('x', { localEndpoints: ollama, inProcess: eigen(), only: `eigen:${MODEL}:1024` }))?.embedder).toBe(`eigen:${MODEL}:1024`)
    })

    it('Privatsphäre: privat geht nie in die Cloud, auch mit Freigabe und Key', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: async () => [], inProcess: eigen(false), allowCloud: true })
        expect(result?.provider).toBe('hash')
        expect(calls.filter(call => /api\.openai\.com|openrouter\.ai/.test(call.url))).toEqual([])
    })

    it('ohne Modelldatei: node-llama-cpp wird nicht geladen, ehrlich null', async () => {
        const dir = join(process.cwd(), '.nova-test-tmp', `einbetter-leer-${randomUUID()}`)
        mkdirSync(dir, { recursive: true })
        const loader = vi.fn(async () => { throw new Error('darf nicht geladen werden') })
        const { loadInProcessEmbedder } = await import('./local-embedder.js')
        expect(await loadInProcessEmbedder({ dir, loader: loader as any })).toBeNull()
        expect(loader).not.toHaveBeenCalled()
    })

    it('Engine: geprüfte Datei, CPU ohne Kompilieren, Text endet mit <|endoftext|> und wird gekürzt', async () => {
        const dir = join(process.cwd(), '.nova-test-tmp', `einbetter-engine-${randomUUID()}`)
        mkdirSync(dir, { recursive: true })
        const bytes = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60, 7)])
        const artifact = testArtifact(bytes)
        writeFileSync(join(dir, artifact.filename), bytes)
        const seen: { getLlama?: any; tokens?: number[] } = {}
        const fakeModule = {
            LlamaLogLevel: { warn: 'warn' },
            getLlama: async (options: any) => {
                seen.getLlama = options
                return {
                    loadModel: async () => ({
                        tokenize: (text: string, special?: boolean) => special && text === '<|endoftext|>' ? [151643] : Array.from({ length: text.length }, (_, i) => i + 1),
                        tokens: { eos: 151645 },
                        createEmbeddingContext: async () => ({
                            getEmbeddingFor: async (input: number[]) => { seen.tokens = input; return { vector: [3, 0, 4, 0] } },
                            dispose: async () => undefined,
                        }),
                        dispose: async () => undefined,
                    }),
                    dispose: async () => undefined,
                }
            },
        }
        const { loadInProcessEmbedder } = await import('./local-embedder.js')
        const engine = await loadInProcessEmbedder({ dir, artifacts: [artifact], loader: async () => fakeModule as any, contextTokens: 16 })
        expect(engine?.model).toBe('test-embed')
        expect(seen.getLlama).toMatchObject({ gpu: false, build: 'never' })
        const vector = await engine!.embed('x'.repeat(40))
        expect(vector).toEqual([0.6, 0, 0.8, 0]) // L2-normalisiert
        expect(seen.tokens).toHaveLength(16)
        expect(seen.tokens!.at(-1)).toBe(151643)

        // Manipulierte Datei: wird nie geladen.
        writeFileSync(join(dir, artifact.filename), Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60, 8)]))
        expect(await loadInProcessEmbedder({ dir, artifacts: [artifact], loader: async () => fakeModule as any })).toBeNull()
    })
})

describe('Bezug nur über fest eingetragene Datei mit sha256', () => {
    it('das gewählte Modell ist fest gepinnt (Revision, Größe, sha256, Dimension, Lizenz)', async () => {
        const { EMBEDDING_ARTIFACTS } = await import('./embedding-artifacts.js')
        expect(EMBEDDING_ARTIFACTS[0]).toMatchObject({
            name: MODEL, filename: 'Qwen3-Embedding-0.6B-Q8_0.gguf', sizeBytes: 639150592, dimension: 1024, license: 'Apache-2.0',
            sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
            url: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf',
        })
    })

    it('installiert nur bei passender Prüfsumme; falsche Bytes hinterlassen keine Datei', async () => {
        const { installEmbeddingArtifact, verifyEmbeddingArtifact, removeEmbeddingArtifact } = await import('./embedding-artifacts.js')
        const dir = join(process.cwd(), '.nova-test-tmp', `einbetter-bezug-${randomUUID()}`)
        const good = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(100, 1)])
        const artifact = testArtifact(good)
        const served: string[] = []
        const serve = (bytes: Buffer) => async (url: string) => { served.push(url); return new Response(bytes, { status: 200 }) }

        await expect(installEmbeddingArtifact(artifact, { dir, fetchImpl: serve(Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(100, 2)])) as any })).rejects.toThrow(/sha256/i)
        expect(existsSync(join(dir, artifact.filename))).toBe(false)
        expect(existsSync(join(dir, `${artifact.filename}.part`))).toBe(false)

        expect(await installEmbeddingArtifact(artifact, { dir, fetchImpl: serve(good) as any })).toMatchObject({ status: 'installiert' })
        expect(served).toEqual(['https://example.com/test-embed.gguf', 'https://example.com/test-embed.gguf'])
        await verifyEmbeddingArtifact(join(dir, artifact.filename), artifact)
        expect(readFileSync(join(dir, artifact.filename)).equals(good)).toBe(true)
        expect(await installEmbeddingArtifact(artifact, { dir, fetchImpl: serve(good) as any })).toMatchObject({ status: 'vorhanden' })
        expect(served).toHaveLength(2)
        await removeEmbeddingArtifact(artifact, dir)
        expect(existsSync(join(dir, artifact.filename))).toBe(false)
    })

    it('Installationskatalog: Eintrag mit festem Programm, Prüfung und Rückweg; Scout-Kandidat zeigt darauf', async () => {
        const { findCatalogEntry, getInstallCatalog } = await import('../install/install-catalog.js')
        const entry = findCatalogEntry(`embedding-gguf:${MODEL}`)
        expect(getInstallCatalog().rejected).toEqual([])
        expect(entry).toMatchObject({
            kind: 'runtime-addon', targets: ['host-agent'], runAs: 'service', approval: 'fragen',
            install: ['{node}', '{program}/dist/memory/local-embedder-fetch.js', 'install', MODEL, '{runtime}/models/embedding'],
            verify: [['{node}', '{program}/dist/memory/local-embedder-fetch.js', 'verify', MODEL, '{runtime}/models/embedding']],
            rollback: { kind: 'command', argv: ['{node}', '{program}/dist/memory/local-embedder-fetch.js', 'remove', MODEL, '{runtime}/models/embedding'] },
        })
        const { getSoftwareCandidates } = await import('../install/software-candidates.js')
        const candidates = getSoftwareCandidates()
        expect(candidates.rejected).toEqual([])
        const candidate = candidates.entries.find(item => item.catalogId === `embedding-gguf:${MODEL}`)
        expect(candidate).toMatchObject({ capability: 'embedding', gpu: 'none', detect: { tools: ['embedding_gguf'] } })
        expect(candidate?.requiresService).toBeUndefined()
        // Vor den Ollama-Kandidaten (Reihenfolge = Vorrang).
        expect(candidates.entries.filter(item => item.capability === 'embedding')[0]?.id).toBe(candidate?.id)
    })
})

describe('Punkt 4 Rest: aktuelle Ollama-API und Modellliste', () => {
    it('ruft /api/embed mit input auf', async () => {
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('privater Eintrag', { localEndpoints: ollama, inProcess: eigen(false) })
        expect(calls.map(call => call.url)).toEqual(['http://ns.example.com:11434/api/embed'])
        expect(calls[0].body).toMatchObject({ model: 'nomic-embed-text:latest', input: 'privater Eintrag' })
        expect(result).toMatchObject({ provider: 'lokal', embedder: 'lokal:nomic-embed-text:4' })
    })

    it('alter Ollama-Server (404 auf /api/embed): Rückfall auf /api/embeddings', async () => {
        ollamaNewApi = false
        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('x', { localEndpoints: ollama, inProcess: eigen(false) })
        expect(calls.map(call => call.url)).toEqual(['http://ns.example.com:11434/api/embed', 'http://ns.example.com:11434/api/embeddings'])
        expect(result?.vector).toEqual([0.25, 0.25, 0.25, 0.25])
    })

    it('aktuelle Modelle vor alten: qwen3-embedding vor nomic-embed-text; fremde IP nie', async () => {
        const { localEmbeddersFromRegistry } = await import('./embedding-providers.js')
        const registry = buildModelRegistry({
            knownNodes: ['ns'],
            ollama: [
                { node: 'ns', baseUrl: 'http://ns.example.com:11434', models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3-embedding:0.6b' }, { name: 'embeddinggemma:300m' }] },
                { baseUrl: 'http://198.51.100.7:11434', models: [{ name: 'qwen3-embedding:8b' }] },
            ],
        })
        expect(localEmbeddersFromRegistry(registry).map(item => item.model)).toEqual(['qwen3-embedding:0.6b', 'embeddinggemma:300m', 'nomic-embed-text:latest'])
    })
})
