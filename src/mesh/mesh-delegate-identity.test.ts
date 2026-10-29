import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKnownNodeNamesForTests } from './known-node-names.js'

// 2.89.15 (Abnahme 2.89.12/13, task D, 29.10.): xaventra-nas answered a mesh_delegate task with the first-contact
// greeting "Du bist als Gast verbunden". delegateTask sent the agent request without userId, so the peer ran it
// as principal `node:xaventra-spark` - an unknown user there. spawn_subagent with mesh_node sends the parent
// identity; mesh_delegate must do the same (the envelope stays signed and fenced by the Main).
const sent = vi.hoisted(() => ({ calls: [] as Array<{ target: string; prompt: string; options: any }> }))
vi.mock('./mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async (target: string, prompt: string, options: any) => {
        sent.calls.push({ target, prompt, options })
        return { requestId: 'req-1', ack: { status: 'delivered', transport: 'direct' } }
    },
}))

afterEach(() => { sent.calls.length = 0; setKnownNodeNamesForTests(null) })

describe('mesh_delegate carries the requesting owner', () => {
    it('delegateTask sends the given user id and budget with the agent request', async () => {
        const { delegateTask } = await import('./mesh-registry.js')
        await delegateTask('xaventra-nas', 'uptime', { userId: '1413797900', timeoutMs: 90_000 })
        expect(sent.calls[0].options).toMatchObject({ userId: '1413797900', budget: { timeoutMs: 90_000 } })
    })

    it('the tool takes the owner from the execution context', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-nas' }])
        const { withExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const { ALL_TOOLS } = await import('../tools/complete-registry.js')
        const tool = ALL_TOOLS.find(entry => entry.name === 'mesh_delegate')!
        await withExecutionPolicyContext({ userId: '1413797900', authUserId: '1413797900', channel: 'telegram' },
            () => tool.handler({ node_id: 'xaventra-nas', task: 'uptime', wait_seconds: 0, userId: 'raw-ignored' }))
        expect(sent.calls[0].options.userId).toBe('1413797900')
    })
})
