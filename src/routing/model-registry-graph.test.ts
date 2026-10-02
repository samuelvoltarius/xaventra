/**
 * 2.85 Paket C: lokale Modelle, die der KI-Scanner findet (eigener Rechner,
 * Mesh, eigenes LAN), landen in der vorhandenen Modell-Registry — mit
 * Datenklasse `lokal`. Der Scanner schreibt Laufzeiten als type 'llm' mit
 * name 'vllm'/'ollama'/'lm-studio'; die Registry hat nur type === 'vllm'
 * bzw. 'ollama' gelesen und solche Funde nie gesehen.
 */
import { describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({ nodes: [] as any[] }))
vi.mock('../mesh/capability-graph.js', () => ({ getCapabilityGraph: () => ({ getSnapshot: () => ({ nodes: graph.nodes }) }) }))
vi.mock('../llm/capability-probe.js', () => ({ getOnlineModels: () => [] }))
vi.mock('../core/outcome-ledger.js', () => ({ getOutcomeLedger: () => ({ listRuns: () => [] }) }))

import { collectModelRegistry } from './model-registry.js'

const runtime = (name: string, type: string, endpoint: string, models: string[]) => ({
    id: `${name}@${endpoint}`, name, type, endpoint, status: 'running', models, capabilities: [type, name], verifiedAt: '2026-10-02T08:00:00Z', verificationSource: 'probe',
})

describe('Modell-Registry liest die Scanner-Funde', () => {
    it('vLLM/Ollama/LM Studio aus dem Scanner (type llm) → Registry-Einträge, lokal; Such- und Sprachdienste nicht', async () => {
        graph.nodes = [
            { id: '192.168.50.40', hostname: '192.168.50.40', host: '192.168.50.40', status: 'unknown', capabilities: [], updatedAt: '2026-10-02T08:00:00Z', runtimes: [
                runtime('vllm', 'llm', 'http://192.168.50.40:8000', ['qwen3-32b']),
                runtime('ollama', 'llm', 'http://192.168.50.40:11434', ['llama3.2:3b', 'nomic-embed-text']),
                runtime('ollama-embeddings', 'embeddings', 'http://192.168.50.40:11434', ['nomic-embed-text']),
                runtime('lm-studio', 'llm', 'http://192.168.50.40:1234', ['gemma-3-4b']),
                runtime('searxng', 'search', 'http://192.168.50.40:8888', []),
                runtime('whisper-server', 'stt', 'http://192.168.50.40:9000', []),
            ] },
        ]
        const registry = await collectModelRegistry({ config: {} })
        const byId = Object.fromEntries(registry.endpoints.map(ep => [ep.id, ep]))
        expect(byId['vllm:192.168.50.40:qwen3-32b']).toMatchObject({ kind: 'vllm', privacy: 'lokal', baseUrl: 'http://192.168.50.40:8000', costEurPerCall: 0 })
        expect(byId['ollama:192.168.50.40:llama3.2:3b']).toMatchObject({ kind: 'ollama', privacy: 'lokal' })
        expect(byId['local-other:192.168.50.40:gemma-3-4b']).toMatchObject({ kind: 'local-other', privacy: 'lokal', baseUrl: 'http://192.168.50.40:1234' })
        expect(registry.endpoints.filter(ep => ep.model === 'nomic-embed-text')).toHaveLength(1)
        expect(registry.endpoints.filter(ep => ep.privacy === 'lokal').every(ep => ep.capabilities.length === 0)).toBe(true) // erkannt ≠ nutzbar
        expect(registry.endpoints.some(ep => /searxng|whisper/.test(ep.id))).toBe(false)
    })
})
