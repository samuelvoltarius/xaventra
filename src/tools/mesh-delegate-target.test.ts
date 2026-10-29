import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { handoffWaitSeconds, setKnownNodeNamesForTests } from '../mesh/known-node-names.js'

// 2.90.1 (Peer-Test 29.10. 13:50): mesh_delegate without node_id sent a task to to_node="undefined" and waited
// 90 s of a ~110 s run. A missing or unknown node is refused at once; the wait stays under the run limit.
const mesh = vi.hoisted(() => ({ delegateTask: vi.fn(), getTaskResult: vi.fn() }))
vi.mock('../mesh/mesh-registry.js', async importOriginal => ({ ...(await importOriginal<object>()), ...mesh }))

import { ALL_TOOLS } from './complete-registry.js'

beforeAll(async () => { await import('../mesh/mesh-registry.js'); await import('../mesh/peer-refusal.js') }, 60_000)
const delegate = () => ALL_TOOLS.find(tool => tool.name === 'mesh_delegate')!
afterEach(() => { setKnownNodeNamesForTests(null); mesh.delegateTask.mockReset(); mesh.getTaskResult.mockReset() })

describe('mesh_delegate needs a real node', () => {
    it.each([{}, { node_id: '' }, { node_id: 'undefined' }, { node_id: '  ' }])('refuses %j without sending', async params => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1', hostname: 'ns1' }])
        const result: any = await delegate().handler({ ...params, task: 'uptime' })
        expect(result.success).toBe(false)
        expect(mesh.delegateTask).not.toHaveBeenCalled()
    })

    it('refuses an unknown node and names the known ones', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1', hostname: 'ns1' }])
        const result: any = await delegate().handler({ node_id: 'xaventra-gibtsnicht', task: 'uptime' })
        expect(result.success).toBe(false)
        expect(result.error).toContain('xaventra-ns1')
        expect(mesh.delegateTask).not.toHaveBeenCalled()
    })

    it('resolves a hostname to the node id and waits at most the hand-over time', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1', hostname: 'ns1' }])
        mesh.delegateTask.mockResolvedValue({ id: 'req-1', to_node: 'xaventra-ns1', status: 'pending', transport: 'direct' })
        mesh.getTaskResult.mockResolvedValue({ id: 'req-1', status: 'done', result: 'ok' })
        await delegate().handler({ node_id: 'ns1', task: 'uptime', wait_seconds: 240 })
        expect(mesh.delegateTask.mock.calls[0][0]).toBe('xaventra-ns1')
        expect(mesh.delegateTask.mock.calls[0][2].timeoutMs).toBe(handoffWaitSeconds() * 1000)
    })
})
