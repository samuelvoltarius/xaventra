import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setKnownNodeNamesForTests } from '../mesh/known-node-names.js'

// 2.90.4 (VM 130 2.90.3, Telegram "test" 23:23:51-23:24:01): mesh_delegate answered three times
// "❌ Nicht an den Knoten übergeben: Knoten nicht erreichbar" while every node was online (spawn_subagent reached ns1
// right after). delegateTask dropped the transport's answer (rejected + reason, unreachable, error) and returned
// null; the tool turned every case into "nicht erreichbar". The real reason is named; a refusal is "abgelehnt".
const transport = vi.hoisted(() => ({ ack: { status: 'delivered', transport: 'direct' } as any, error: null as Error | null }))
vi.mock('../mesh/mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async () => {
        if (transport.error) throw transport.error
        return { requestId: 'req-1', ack: transport.ack }
    },
}))

import { ALL_TOOLS } from './complete-registry.js'

beforeAll(async () => { await import('../mesh/mesh-registry.js'); await import('../mesh/peer-refusal.js') }, 60_000)
afterEach(() => { setKnownNodeNamesForTests(null); transport.ack = { status: 'delivered', transport: 'direct' }; transport.error = null })
const delegate = (params: Record<string, unknown>) => ALL_TOOLS.find(tool => tool.name === 'mesh_delegate')!.handler(params)

describe('mesh_delegate names the real reason a task was not handed over', () => {
    it('a node that rejects the request is "abgelehnt" with the reason, never "nicht erreichbar"', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1' }])
        transport.ack = { status: 'rejected', transport: 'direct', reason: 'Error: agent_tool_not_globally_allowed' }
        const text = JSON.stringify(await delegate({ node_id: 'xaventra-ns1', task: 'uptime', wait_seconds: 0 }))
        expect(text).toMatch(/abgelehnt/)
        expect(text).toMatch(/Werkzeuge/)
        expect(text).not.toMatch(/nicht erreichbar/)
        const { isHandoffRefusal } = await import('../mesh/peer-refusal.js')
        expect(isHandoffRefusal(text)).toBe(true)
    })

    it('no route is "nicht erreichbar" with the transport reason; an exception names its cause', async () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1' }])
        transport.ack = { status: 'unreachable', transport: 'direct', reason: 'no route to xaventra-ns1' }
        expect(JSON.stringify(await delegate({ node_id: 'xaventra-ns1', task: 'uptime', wait_seconds: 0 }))).toMatch(/nicht erreichbar.*no route/)
        transport.error = new Error('Main fence not held (nova-main)')
        const failed = JSON.stringify(await delegate({ node_id: 'xaventra-ns1', task: 'uptime', wait_seconds: 0 }))
        expect(failed).toMatch(/Main fence not held/)
        expect(failed).not.toMatch(/Knoten nicht erreichbar\./)
    })
})
