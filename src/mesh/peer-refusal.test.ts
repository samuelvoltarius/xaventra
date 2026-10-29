import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOnboardingMessage, type UserRecord } from '../users/multi-user-middleware.js'
import { setKnownNodeNamesForTests } from './known-node-names.js'

// 2.90.1 (Peer-Test 29.10., 2.89.15 auf ns1/ns2/NAS): the NAS answered a hand-over in 5-42 ms with its fixed guest
// greeting ("Du bist als Gast verbunden …"), the Main took that as the result, asked the node four more times and
// ran into the 110 s limit. A guest/refusal answer of a peer is a failed hand-over with one clear sentence, and the
// same node is not asked again in the same run.
const net = vi.hoisted(() => ({ sends: 0, reply: '' }))
vi.mock('./mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => { net.sends++; return { requestId: `req-${net.sends}`, ack: { status: 'delivered', transport: 'direct' } } },
    waitForMeshRunResult: async () => ({ success: true, result: net.reply, evidence: [] }),
    cancelMeshRun: async () => undefined,
}))

const guestRecord: UserRecord = { id: '1000000001', permission: 'guest', firstSeen: 0, lastSeen: 0, messageCount: 0, channel: 'telegram', onboarded: false }
const GUEST_REPLY = getOnboardingMessage({ ...guestRecord })!

afterEach(() => { net.sends = 0; net.reply = ''; setKnownNodeNamesForTests(null) })

async function handOver(task: string) {
    const { ALL_TOOLS } = await import('../tools/complete-registry.js')
    const { withExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const tool = ALL_TOOLS.find(entry => entry.name === 'spawn_subagent')!
    return withExecutionPolicyContext({ runId: 'run-guest', userId: '1000000001', authUserId: '1000000001', channel: 'telegram' },
        () => tool.handler({ task, mesh_node: 'xaventra-nas', timeout_seconds: 30 }))
}

describe('a peer that answers as guest is a failed hand-over', () => {
    it('the guest greeting is no result; a second hand-over to the node in the same run is not sent', async () => {
        net.reply = `${GUEST_REPLY}\n\nIch kann dir dabei leider nicht helfen.`
        const first = String(await handOver('Wie spät ist es dort?'))
        expect(first).toMatch(/xaventra-nas/)
        expect(first).toMatch(/Gast/)
        expect(first).toMatch(/nicht erneut/i)
        expect(first).not.toMatch(/fertig/)
        const second = String(await handOver('Wie spät ist es dort? Bitte nochmal.'))
        expect(net.sends).toBe(1)
        expect(second).toBe(first)
    }, 60_000)

    it('mesh_delegate reports the guest answer as failure', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns2' }])
        const registry = await import('./mesh-registry.js')
        vi.spyOn(registry, 'getTaskResult').mockResolvedValue({ id: 'req-1', status: 'done', result: GUEST_REPLY } as any)
        const { ALL_TOOLS } = await import('../tools/complete-registry.js')
        const result: any = await ALL_TOOLS.find(entry => entry.name === 'mesh_delegate')!.handler({ node_id: 'xaventra-ns2', task: 'uptime', wait_seconds: 5 })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Gast/)
    }, 60_000)

    it('the peer sends no greeting into a mesh hand-over', () => {
        expect(getOnboardingMessage({ ...guestRecord, channel: 'mesh-direct' })).toBeNull()
    })
})
