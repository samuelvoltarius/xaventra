import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setKnownNodeNamesForTests } from '../mesh/known-node-names.js'

// 2.89.16 (Abnahme 2.89.12–2.89.15): ns1/ns2 answered delegated tasks with their own runner timeout sentence
// ("Das hat zu lange gedauert, ich war nicht rechtzeitig fertig …") and mesh_delegate returned it as
// "Ergebnis von xaventra-ns2". That is no result: the delegation failed.
const mesh = vi.hoisted(() => ({ delegateTask: vi.fn(), getTaskResult: vi.fn() }))
vi.mock('../mesh/mesh-registry.js', async importOriginal => ({ ...(await importOriginal<object>()), ...mesh }))
import { ALL_TOOLS } from './complete-registry.js'

beforeAll(async () => { await import('../mesh/mesh-registry.js'); setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns2' }]) }, 60_000)
afterAll(() => setKnownNodeNamesForTests(null))
afterEach(() => { vi.useRealTimers(); mesh.delegateTask.mockReset(); mesh.getTaskResult.mockReset() })

describe('a peer timeout is a failed delegation', () => {
    it('returns success:false with the node name', async () => {
        vi.useFakeTimers()
        mesh.delegateTask.mockResolvedValue({ id: 'req-9', to_node: 'xaventra-ns2', status: 'pending', transport: 'direct' })
        mesh.getTaskResult.mockResolvedValue({ id: 'req-9', status: 'done', result: '"Das hat zu lange gedauert, ich war nicht rechtzeitig fertig. Versuch es bitte gleich noch einmal."' })
        const tool = ALL_TOOLS.find(entry => entry.name === 'mesh_delegate')!
        const pending = tool.handler({ node_id: 'xaventra-ns2', task: 'uptime' })
        for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1_000)
        const result: any = await pending
        expect(result.success).toBe(false)
        expect(String(result.error)).toMatch(/xaventra-ns2/)
        expect(String(result.error)).toMatch(/nicht rechtzeitig|Zeitlimit/)
    })
})
