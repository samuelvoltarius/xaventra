import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Live-Befund Spark (02.10.): node-llama-cpp meldet „A prebuilt binary was not
// found“ (CUDA-Variante fehlt im Release, nur CPU-Prebuilt dabei). Der eigene
// Einbetter darf nie kompilieren: kein Binding -> sauber auf den nächsten Rang
// (Mesh-Ollama, sonst Hash) und das genau EINMAL melden, nicht bei jedem Versuch.

afterEach(() => { vi.restoreAllMocks(); delete process.env.XAVENTRA_EMBEDDING_MODEL_DIR })

describe('Eigener Einbetter ohne passendes Binding', () => {
    it('Ladefehler -> null, nächster Rang, Meldung nur einmal je Prozess', async () => {
        const dir = join(process.cwd(), '.nova-test-tmp', `einbetter-binding-${randomUUID()}`)
        mkdirSync(dir, { recursive: true })
        const bytes = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(32, 3)])
        const artifact = { name: 'test-embed', filename: 'test-embed.gguf', url: 'https://example.com/test-embed.gguf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dimension: 4, license: 'Apache-2.0', releasedAt: '2025-06' }
        writeFileSync(join(dir, artifact.filename), bytes)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const options = { requested: [] as any[] }
        const loader = async () => ({
            LlamaLogLevel: { warn: 'warn' },
            getLlama: async (opts: any) => { options.requested.push(opts); throw new Error('A prebuilt binary was not found') },
        }) as any
        vi.resetModules()
        const { loadInProcessEmbedder } = await import('./local-embedder.js')
        expect(await loadInProcessEmbedder({ dir, artifacts: [artifact], loader })).toBeNull()
        expect(await loadInProcessEmbedder({ dir, artifacts: [artifact], loader })).toBeNull()
        expect(options.requested.every(opts => opts.gpu === false && opts.build === 'never')).toBe(true)
        expect(warn.mock.calls.filter(call => String(call[0]).includes('Eigener Einbetter'))).toHaveLength(1)

        const { embed } = await import('./embedding-providers.js') as any
        const result = await embed('x', { localEndpoints: async () => [], inProcess: async () => loadInProcessEmbedder({ dir, artifacts: [artifact], loader }) })
        expect(result?.provider).toBe('hash')
    })

    it('Modelle liegen im Laufzeit-Ordner (überleben Programm-Updates), nicht im Programm-Ordner', async () => {
        const { embeddingModelsDir } = await import('./embedding-artifacts.js')
        const { getRuntimeRoot } = await import('../core/data-root.js')
        expect(embeddingModelsDir()).toBe(join(getRuntimeRoot(), 'models', 'embedding'))
        process.env.XAVENTRA_EMBEDDING_MODEL_DIR = join(process.cwd(), '.nova-test-tmp', 'anders')
        expect(embeddingModelsDir()).toBe(join(process.cwd(), '.nova-test-tmp', 'anders'))
    })

    it('Bezugsprogramm schreibt in den vom Katalog übergebenen Laufzeit-Ordner', async () => {
        const { findCatalogEntry } = await import('../install/install-catalog.js')
        const entry = findCatalogEntry('embedding-gguf:qwen3-embedding-0.6b-q8_0')
        expect(entry?.install).toEqual(['{node}', '{program}/dist/memory/local-embedder-fetch.js', 'install', 'qwen3-embedding-0.6b-q8_0', '{runtime}/models/embedding'])
        expect(entry?.verify).toEqual([['{node}', '{program}/dist/memory/local-embedder-fetch.js', 'verify', 'qwen3-embedding-0.6b-q8_0', '{runtime}/models/embedding']])
        const { runEmbeddingFetch } = await import('./local-embedder-fetch.js')
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        expect(await runEmbeddingFetch(['verify', 'qwen3-embedding-0.6b-q8_0', 'relativ/ordner'])).toBe(2)
        expect(await runEmbeddingFetch(['verify', 'qwen3-embedding-0.6b-q8_0', '/x/../y'])).toBe(2)
    })
})
