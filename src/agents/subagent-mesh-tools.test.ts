import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Langtest B (2.90.0): spawn_subagent with mesh_node and no tools sent Main's
// local SAFE_DEFAULT_TOOLS (run_python, fetch_url, web_search, get_time …); ns1
// refused with agent_tool_not_globally_allowed. Main now sends the agent tool
// list the target itself accepts. The peer policy stays as strict as before.

const NS1_LIST = ['read_file', 'list_directory', 'find_files', 'code_search', 'code_outline', 'health_status', 'nova_status',
    'nova_introspect', 'nova_capabilities', 'mesh_status', 'mesh_nodes', 'find_capability', 'resolve_capability']

const mesh = vi.hoisted(() => ({ sent: [] as any[], reported: undefined as string[] | undefined, verify: (_tools: string[] | undefined) => ({ accepted: true } as { accepted: boolean; reason?: string }) }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({
    sendAgentRequest: async (_node: string, _prompt: string, options: any) => {
        mesh.sent.push(options)
        const verdict = mesh.verify(options.allowedTools)
        return { requestId: 'req-1', ack: verdict.accepted ? { status: 'delivered' } : { status: 'rejected', reason: verdict.reason } }
    },
    waitForMeshRunResult: async () => ({ success: true, result: 'ns1 ok' }),
    cancelMeshRun: async () => undefined,
    reportedRemoteAgentTools: () => mesh.reported,
}))
vi.mock('./nova-runner.js', () => ({ runNovaAgent: vi.fn() }))
vi.mock('../llm/nova-llm-sdk.js', () => ({ createNovaLLMClient: async () => ({}) }))

const sandbox = join(process.cwd(), '.nova-test-tmp', `subagents-mesh-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { MeshIdentity } = await import('../mesh/mesh-identity.js')
const { MeshPolicy, remoteAgentToolList } = await import('../mesh/mesh-policy.js')
const { spawnSubagent } = await import('./subagent-orchestrator.js')

// ns1 exactly as configured live: explicit mesh.security.allowedTools, Main as owner peer.
const main = new MeshIdentity('xaventra-spark', mkdtempSync(join(tmpdir(), 'mesh-sub-main-')))
const ns1Policy = new MeshPolicy({ mode: 'direct', allowedTools: NS1_LIST,
    peers: [{ nodeId: 'xaventra-spark', transport: 'direct', status: 'unknown', publicKey: main.publicKey, roles: ['system', 'owner'] }] }, 'xaventra-ns1')
let n = 0
const ns1Verdict = (allowedTools: string[] | undefined) => ns1Policy.verify(main.create({
    kind: 'agent.request', targetNode: 'xaventra-ns1', principal: { id: 'owner', role: 'owner' },
    payload: { prompt: 'Wie geht es dir?', idempotencyKey: `subagent:t${++n}`, ...(allowedTools ? { allowedTools } : {}) },
    fence: { service: 'nova-main', epoch: 1, token: 'fence', authority: 'static' },
}))

beforeEach(() => { mesh.sent = []; mesh.reported = undefined; mesh.verify = ns1Verdict })

describe('mesh subagent tool list (Langtest B)', () => {
    it('Main -> ns1 without tools: sends the list ns1 reports and ns1 accepts it', async () => {
        mesh.reported = remoteAgentToolList(NS1_LIST)
        const result = await spawnSubagent({ task: 'Wie geht es dir?', meshNode: 'xaventra-ns1' })
        expect(mesh.sent[0].allowedTools).toEqual([...NS1_LIST].sort())
        expect(ns1Verdict(mesh.sent[0].allowedTools)).toMatchObject({ accepted: true })
        expect(result).toMatchObject({ status: 'completed', mode: 'mesh' })
    })
    it('without a report, sends the peer code default (never Main-only tools like run_python or web_search)', async () => {
        await spawnSubagent({ task: 'Status?', meshNode: 'xaventra-ns2' })
        const sent: string[] = mesh.sent[0].allowedTools
        expect(sent).toEqual(remoteAgentToolList(undefined))
        for (const name of ['run_python', 'web_search', 'fetch_url', 'memory_store', 'get_time']) expect(sent).not.toContain(name)
        expect(sent).toContain('get_current_time')
    })
    it('Gegenprobe: an explicitly requested run_python stays refused by ns1', async () => {
        mesh.reported = remoteAgentToolList(NS1_LIST)
        const result = await spawnSubagent({ task: 'Rechne', meshNode: 'xaventra-ns1', tools: ['run_python'] })
        expect(mesh.sent[0].allowedTools).toEqual(['run_python'])
        expect(ns1Verdict(['run_python'])).toMatchObject({ accepted: false, reason: 'agent_tool_not_globally_allowed' })
        expect(result).toMatchObject({ status: 'failed' })
    })
    it('a reported list never smuggles in never-remote or risky tools', async () => {
        mesh.reported = ['read_file', 'run_command', 'ssh_command', 'self_evolve']
        mesh.verify = () => ({ accepted: true })
        await spawnSubagent({ task: 'x', meshNode: 'xaventra-ns1' })
        expect(mesh.sent[0].allowedTools).toEqual(['read_file'])
    })
})

describe('remote agent tool list published by a node', () => {
    it('is the accepted list minus never-remote tools, sorted', () => {
        expect(remoteAgentToolList(['read_file', 'run_command', 'nova_status'])).toEqual(['nova_status', 'read_file'])
        expect(remoteAgentToolList(undefined)).toContain('get_current_time')
        expect(remoteAgentToolList([])).toEqual(remoteAgentToolList(undefined))
    })
})
