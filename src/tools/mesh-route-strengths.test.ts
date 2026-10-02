import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { StrengthFacts, StrengthNodeFacts } from '../mesh/node-strengths.js'

// 2.86 Paket J: das Werkzeug mesh_route fragte die eigene Routing-Tabelle der
// SSH-gestützten MeshBrain (Doppelung). Jetzt antwortet es aus dem einen
// Stärken-Modul; spawn_subagent kennt mesh_node="auto" + faehigkeit.
const NOW = Date.now()
const node = (id: string, patch: Partial<StrengthNodeFacts>, hw: Partial<StrengthNodeFacts['hardware']> = {}): StrengthNodeFacts => ({
    nodeId: id, local: false, lastSeen: NOW - 10_000, runtimes: [], tools: [], selfCheck: 'ok', ...patch,
    hardware: { cpus: 4, ramGB: 8, gpuName: null, gpuBackend: 'cpu', viaVllm: false, ...hw },
})
const facts: StrengthFacts = {
    now: NOW, measurements: [],
    nodes: [
        node('main-x', { local: true }, { ramGB: 32 }),
        node('knoten-b', { runtimes: [{ name: 'ollama', type: 'llm', models: ['qwen2.5:72b'], running: true }] }, { ramGB: 128, viaVllm: true, gpuName: 'GB10', gpuBackend: 'cuda' }),
    ],
}
vi.mock('../mesh/node-strengths.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../mesh/node-strengths.js')>()),
    collectStrengthFacts: vi.fn(async () => facts),
}))
vi.mock('../mesh/mesh-brain.js', () => ({ getMeshBrain: () => { throw new Error('mesh_route must not use the SSH MeshBrain') } }))
vi.mock('../core/skills-loader.js', () => ({ loadAllSkills: () => [] }))
vi.mock('../mesh/event-hub.js', () => ({ emit: vi.fn() }))

let registry: typeof import('./complete-registry.js')
beforeAll(async () => { registry = await import('./complete-registry.js') }, 120_000)

describe('mesh_route aus dem Stärken-Modul', () => {
    it('große Modelle → knoten-b mit Begründung; alte Aufgabennamen gelten weiter', async () => {
        const tool = registry.ALL_TOOLS.find(entry => entry.name === 'mesh_route')!
        const text = String(await tool.handler({ task: 'grosse-modelle' }))
        expect(text).toMatch(/1\. knoten-b/)
        expect(text).toMatch(/128 GB/)
        expect(String(await tool.handler({ task: 'large-llm' }))).toMatch(/1\. knoten-b/)
        expect(String(await tool.handler({ task: 'zaubern' }))).toMatch(/Unbekannte Fähigkeit/)
    })

    it('spawn_subagent bietet mesh_node="auto" und faehigkeit an', () => {
        const spawn = registry.ALL_TOOLS.find(entry => entry.name === 'spawn_subagent')!
        expect(spawn.parameters.map(param => param.name)).toEqual(expect.arrayContaining(['mesh_node', 'faehigkeit']))
        expect(spawn.parameters.find(param => param.name === 'mesh_node')!.description).toContain('auto')
    })
})
