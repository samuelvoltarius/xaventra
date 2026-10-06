import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Mesh-Gehirn 2.88: the owner question "was kann welcher Node?" is one tool
// call with a short list; spawn_subagent mesh_node="auto" places the task by
// strength and says why.

const strengths = vi.hoisted(() => ({
    collectNodeStrengths: vi.fn(async () => []),
    formatStrengthList: vi.fn(() => '*Was kann welcher Knoten?*\n• gpu-box — Bilder erzeugen · GPU frei'),
}))
vi.mock('../mesh/node-strengths.js', async original => ({ ...(await original() as object), ...strengths }))
const router = vi.hoisted(() => ({ routeTask: vi.fn() }))
vi.mock('../mesh/mesh-router.js', async original => ({ ...(await original() as object), routeTask: router.routeTask }))
const orchestrator = vi.hoisted(() => ({ spawnSubagent: vi.fn(async (task: any) => ({ id: 'sa-1', status: 'completed', output: 'fertig', durationMs: 5, toolsUsed: [], mode: task.meshNode ? 'mesh' : 'local', meshNode: task.meshNode })) }))
vi.mock('../agents/subagent-orchestrator.js', async original => ({ ...(await original() as object), spawnSubagent: orchestrator.spawnSubagent }))

let registry: typeof import('./complete-registry.js')
beforeAll(async () => { registry = await import('./complete-registry.js') }, 120_000)
beforeEach(() => { orchestrator.spawnSubagent.mockClear(); router.routeTask.mockReset() })
const tool = (name: string) => registry.ALL_TOOLS.find(entry => entry.name === name)!

describe('mesh strength tools', () => {
    it('mesh_strengths answers the owner question with the short list', async () => {
        expect(await tool('mesh_strengths').handler({})).toBe('*Was kann welcher Knoten?*\n• gpu-box — Bilder erzeugen · GPU frei')
    })

    it('spawn_subagent mesh_node=auto delegates to the strongest node and names the reason', async () => {
        router.routeTask.mockResolvedValue({ nodeId: 'gpu-box', isLocal: false, reason: 'gpu-box: GPU frei, comfyui läuft' })
        const text = await tool('spawn_subagent').handler({ task: 'Erzeuge ein Bild', mesh_node: 'auto' })
        expect(orchestrator.spawnSubagent.mock.calls[0][0]).toMatchObject({ task: 'Erzeuge ein Bild', meshNode: 'gpu-box' })
        expect(text).toMatch(/^Knoten: gpu-box \(gpu-box: GPU frei, comfyui läuft\)\n✅ Subagent sa-1 fertig/)
    })

    it('mesh_node=auto stays local when this node fits best', async () => {
        router.routeTask.mockResolvedValue({ nodeId: 'here', isLocal: true, reason: 'normale Aufgabe — läuft hier' })
        await tool('spawn_subagent').handler({ task: 'Fasse den Text zusammen', mesh_node: 'auto' })
        expect(orchestrator.spawnSubagent.mock.calls[0][0].meshNode).toBeUndefined()
    })
})
