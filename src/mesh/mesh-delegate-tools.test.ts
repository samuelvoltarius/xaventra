import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Langtest B follow-up: mesh_delegate sent no allowedTools, so the peer ran the
// task with [] (no tools at all). It now sends the tools the target reports it
// accepts, like spawn_subagent with mesh_node; the peer policy is unchanged.
const NS1_LIST = ['read_file', 'list_directory', 'find_files', 'code_search', 'code_outline', 'health_status', 'nova_status',
    'nova_introspect', 'nova_capabilities', 'mesh_status', 'mesh_nodes', 'find_capability', 'resolve_capability']
const sent = vi.hoisted(() => ({ calls: [] as any[], reported: undefined as string[] | undefined }))
vi.mock('./mesh-transport-runtime.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    sendAgentRequest: async (_target: string, _prompt: string, options: any) => {
        sent.calls.push(options)
        return { requestId: 'req-1', ack: { status: 'delivered', transport: 'direct' } }
    },
    reportedRemoteAgentTools: () => sent.reported,
}))
afterEach(() => { sent.calls.length = 0; sent.reported = undefined })

const { MeshIdentity } = await import('./mesh-identity.js')
const { MeshPolicy, remoteAgentToolList } = await import('./mesh-policy.js')
const main = new MeshIdentity('xaventra-spark', mkdtempSync(join(tmpdir(), 'delegate-tools-main-')))
const ns1 = new MeshPolicy({ mode: 'direct', allowedTools: NS1_LIST,
    peers: [{ nodeId: 'xaventra-spark', transport: 'direct', status: 'unknown', publicKey: main.publicKey, roles: ['system', 'owner'] }] }, 'xaventra-ns1')
let n = 0
const ns1Verdict = (allowedTools: string[]) => ns1.verify(main.create({
    kind: 'agent.request', targetNode: 'xaventra-ns1', principal: { id: 'owner', role: 'owner' },
    payload: { prompt: 'uptime', idempotencyKey: `mesh-task:t${++n}`, allowedTools },
    fence: { service: 'nova-main', epoch: 1, token: 'fence', authority: 'static' },
}))

describe('mesh_delegate sends the tools the target accepts', () => {
    it('Main -> ns1: the reported ns1 list, accepted by ns1 (never an empty list)', async () => {
        sent.reported = remoteAgentToolList(NS1_LIST)
        const { delegateTask } = await import('./mesh-registry.js')
        await delegateTask('xaventra-ns1', 'uptime', { userId: 'owner' })
        expect(sent.calls[0].allowedTools).toEqual([...NS1_LIST].sort())
        expect(ns1Verdict(sent.calls[0].allowedTools)).toMatchObject({ accepted: true })
    })
    it('without a report: the peer code default minus risky tools', async () => {
        const { delegateTask } = await import('./mesh-registry.js')
        await delegateTask('xaventra-ns2', 'uptime')
        const tools: string[] = sent.calls[0].allowedTools
        expect(tools).toEqual(remoteAgentToolList(undefined))
        expect(tools.length).toBeGreaterThan(0)
        for (const name of ['run_command', 'ssh_command', 'run_python']) expect(tools).not.toContain(name)
    })
    it('Gegenprobe: an explicitly requested run_python is passed on and ns1 still refuses it', async () => {
        sent.reported = remoteAgentToolList(NS1_LIST)
        const { delegateTask } = await import('./mesh-registry.js')
        await delegateTask('xaventra-ns1', 'rechne', { allowedTools: ['run_python'] })
        expect(sent.calls[0].allowedTools).toEqual(['run_python'])
        expect(ns1Verdict(['run_python'])).toMatchObject({ accepted: false, reason: 'agent_tool_not_globally_allowed' })
    })
})
