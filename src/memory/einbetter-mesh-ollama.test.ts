import { describe, expect, it, vi } from 'vitest'

// Live-Befund Spark nach 2.84.0 (02.10. 09:28): „[Embeddings] Einbetter:
// hash:v1:768“, obwohl auf ns1 (Tailnet) ein Ollama mit nomic-embed-text läuft.
// Ursache im Code: AIScan meldet Ollama/vLLM als Laufzeit `type: 'llm'`
// (`name: 'ollama'`, Fähigkeit `ollama`); das Modell-Register nahm aus dem
// Capability-Graphen nur `type === 'ollama'`/`'vllm'` — Ollama auf anderen
// Knoten kam nie ins Register. Dazu meldet ein Knoten seinen eigenen Dienst als
// `http://localhost:11434`; vom Main aus gilt dafür die Adresse des Knotens.

const NOW = new Date().toISOString()
const graph = vi.hoisted(() => ({ nodes: [] as any[] }))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ version: 1, updatedAt: '', nodes: graph.nodes, tombstones: [] }) }) }))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'spark' }))
vi.mock('../llm/capability-probe.js', () => ({ getOnlineModels: () => [] }))
vi.mock('../core/outcome-ledger.js', () => ({ getOutcomeLedger: () => ({ listRuns: () => [] }) }))

const runtime = (name: string, endpoint: string, models: string[], extra: Record<string, unknown> = {}) => ({
    id: `${name}@${endpoint}`, name, type: 'llm', endpoint, status: 'running', models, capabilities: ['llm', name], verifiedAt: NOW, verificationSource: 'mesh-heartbeat', ...extra,
})

describe('Mesh-Ollama auf einem anderen Knoten wird als eigener Einbetter gefunden', () => {
    it('AIScan-Laufzeit `llm`/ollama auf ns1 -> Register-Eintrag lokal, Einbetter mit Knotenadresse', async () => {
        graph.nodes = [
            { id: 'spark', hostname: 'spark', host: 'spark.example.com', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('vllm', 'http://localhost:8000/v1', ['qwen-test'])] },
            { id: 'ns1', hostname: 'ns1', host: 'ns1.example.com', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('ollama', 'http://localhost:11434', ['nomic-embed-text:latest', 'qwen3.5:4b'])] },
            { id: 'ns2', hostname: 'ns2', status: 'online', capabilities: [], updatedAt: NOW,
                runtimes: [runtime('ollama', 'http://127.0.0.1:11434', ['nomic-embed-text:latest'])] },
        ]
        const { collectModelRegistry } = await import('../routing/model-registry.js')
        const { localEmbeddersFromRegistry } = await import('./embedding-providers.js')
        const registry = await collectModelRegistry({ config: {} })
        const ns1 = registry.endpoints.find(ep => ep.node === 'ns1' && ep.model === 'nomic-embed-text:latest')
        expect(ns1).toMatchObject({ kind: 'ollama', privacy: 'lokal', baseUrl: 'http://ns1.example.com:11434' })
        expect(localEmbeddersFromRegistry(registry)).toEqual([{ baseUrl: 'http://ns1.example.com:11434', model: 'nomic-embed-text:latest', node: 'ns1' }])
        // Eigener Knoten: localhost bleibt localhost; ns2 ohne Adresse wird nicht geraten.
        expect(registry.endpoints.find(ep => ep.node === 'spark')).toMatchObject({ kind: 'vllm', baseUrl: 'http://localhost:8000/v1', privacy: 'lokal' })
        expect(registry.endpoints.some(ep => ep.node === 'ns2')).toBe(false)
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
