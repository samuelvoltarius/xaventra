/**
 * Live-Befund Spark nach 2.84.0 (02.10. 09:28): „[Embeddings] Einbetter:
 * hash:v1:768“, obwohl auf ns1 (Tailnet) ein Ollama mit nomic-embed-text läuft.
 * Ursache im Code: AIScan meldet Ollama/vLLM als Laufzeit `type: 'llm'`
 * (`name: 'ollama'`, Fähigkeit `ollama`); das Modell-Register nahm aus dem
 * Capability-Graphen nur `type === 'ollama'`/`'vllm'` — Ollama auf anderen
 * Knoten kam nie ins Register.
 * 2.89.4: Ein Knoten meldet seinen eigenen Dienst als `http://localhost:11434`.
 * Das ist eine Fähigkeit DIESES Knotens — der Main ruft sie nie per HTTP über
 * die Peer-Adresse, sondern nur als Mesh-Job (`mesh://ns1`).
 */
import { describe, expect, it, vi } from 'vitest'

const NOW = new Date().toISOString()
const graph = vi.hoisted(() => ({ nodes: [] as any[] }))
const meshJobs = vi.hoisted(() => ({ calls: [] as Array<{ node: string; type: string; payload: any }>, results: [] as Array<() => any> }))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ version: 1, updatedAt: '', nodes: graph.nodes, tombstones: [] }) }) }))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'spark' }))
vi.mock('../llm/capability-probe.js', () => ({ getOnlineModels: () => [] }))
vi.mock('../core/outcome-ledger.js', () => ({ getOutcomeLedger: () => ({ listRuns: () => [] }) }))
vi.mock('../mesh/mesh-remote-exec.js', () => ({
    remoteExec: async (node: string, type: string, payload: any) => {
        meshJobs.calls.push({ node, type, payload })
        const next = meshJobs.results.shift()
        return next ? next() : { requestId: 'r', from: node, success: true, result: { embeddings: [[0.5, 0.5, 0.5, 0.5]] }, durationMs: 1 }
    },
    registerHandler: () => undefined,
}))

const runtime = (name: string, endpoint: string, models: string[], extra: Record<string, unknown> = {}) => ({
    id: `${name}@${endpoint}`, name, type: 'llm', endpoint, status: 'running', models, capabilities: ['llm', name], verifiedAt: NOW, verificationSource: 'mesh-heartbeat', ...extra,
})

describe('Mesh-Ollama auf einem anderen Knoten wird als eigener Einbetter gefunden', () => {
    it('AIScan-Laufzeit `llm`/ollama auf ns1 -> Register-Eintrag lokal, Aufruf nur als Mesh-Job', async () => {
        graph.nodes = [
            { id: 'spark', hostname: 'spark', host: 'spark.example.com', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('vllm', 'http://localhost:8000/v1', ['qwen-test'])] },
            { id: 'ns1', hostname: 'ns1', host: 'ns1.example.com', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('ollama', 'http://localhost:11434', ['nomic-embed-text:latest', 'qwen3.5:4b'])] },
            { id: 'ns2', hostname: 'ns2', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('ollama', 'http://127.0.0.1:11434', ['nomic-embed-text:latest'])] },
        ]
        const { collectModelRegistry } = await import('../routing/model-registry.js')
        const { localEmbeddersFromRegistry, embed } = await import('./embedding-providers.js')
        const registry = await collectModelRegistry({ config: {} })
        const ns1 = registry.endpoints.find(ep => ep.node === 'ns1' && ep.model === 'nomic-embed-text:latest')
        // Keine Peer-HTTP-Adresse — nur ein Mesh-Handle auf den Knoten.
        expect(ns1).toMatchObject({ kind: 'ollama', privacy: 'lokal', baseUrl: 'mesh://ns1' })
        expect(ns1?.baseUrl).not.toMatch(/ns1\.example\.com|11434/)
        expect(localEmbeddersFromRegistry(registry, { localNodeId: 'spark' })).toEqual([
            { baseUrl: 'mesh://ns1', model: 'nomic-embed-text:latest', node: 'ns1', viaMesh: true },
            { baseUrl: 'mesh://ns2', model: 'nomic-embed-text:latest', node: 'ns2', viaMesh: true },
        ])
        // Eigener Knoten: localhost bleibt localhost.
        expect(registry.endpoints.find(ep => ep.node === 'spark')).toMatchObject({ kind: 'vllm', baseUrl: 'http://localhost:8000/v1', privacy: 'lokal' })

        // Einbetten: Mesh-Job an ns1, nie fetch an ns1.example.com / 11434.
        meshJobs.calls.length = 0
        meshJobs.results.length = 0
        const peerFetch = vi.fn(async () => { throw new Error('Main ruft die Peer-Adresse nicht an') })
        vi.stubGlobal('fetch', peerFetch)
        const result = await embed('privater Eintrag', {
            inProcess: async () => null,
            localEndpoints: async () => localEmbeddersFromRegistry(registry, { localNodeId: 'spark' }),
        })
        vi.unstubAllGlobals()
        expect(result).toMatchObject({ provider: 'lokal', model: 'nomic-embed-text' })
        expect(meshJobs.calls).toEqual([{ node: 'ns1', type: 'ollama-api', payload: { path: '/api/embed', body: { model: 'nomic-embed-text:latest', input: 'privater Eintrag', truncate: true } } }])
        expect(peerFetch).not.toHaveBeenCalled()
    })

    it('Gegenprobe: nur laufende Dienste; ein fremder Name ist kein Ollama', async () => {
        graph.nodes = [
            { id: 'ns1', hostname: 'ns1', host: 'ns1.example.com', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('ollama', 'http://localhost:11434', ['nomic-embed-text:latest'], { status: 'stopped' }), runtime('comfyui', 'http://localhost:8188', ['x'])] },
        ]
        const { collectModelRegistry } = await import('../routing/model-registry.js')
        expect((await collectModelRegistry({ config: {} })).endpoints.filter(ep => ep.node === 'ns1')).toEqual([])
    })
})
