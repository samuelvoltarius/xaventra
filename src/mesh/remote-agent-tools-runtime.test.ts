import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Langtest B: a node publishes the agent tools it accepts in its signed node.tools
// inventory; Main reads them back per node and ignores malformed lists.
let runtime: typeof import('./mesh-transport-runtime.js')
let sender: import('./mesh-transport-router.js').MeshTransportRouter
beforeAll(async () => {
    vi.stubEnv('NOVA_NODE_ID', 'tools-main')
    vi.stubEnv('NOVA_RUNTIME_ROOT', mkdtempSync(join(tmpdir(), 'tools-main-root-')))
    const { MeshIdentity } = await import('./mesh-identity.js')
    const { MeshTransportRouter } = await import('./mesh-transport-router.js')
    const { LocalMeshTransport } = await import('./local-mesh-transport.js')
    const peer = new MeshIdentity('tools-ns1', mkdtempSync(join(tmpdir(), 'tools-ns1-')))
    const main = new MeshIdentity('tools-main')
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'direct', direct: { enabled: false, peers: [{ nodeId: peer.nodeId, publicKey: peer.publicKey, roles: ['worker'] }] } } }))
    sender = new MeshTransportRouter(peer, { id: 'node:tools-ns1', role: 'worker', channel: 'mesh' }, { mode: 'standalone', peers: [{ nodeId: main.nodeId, publicKey: main.publicKey, roles: ['system'], transport: 'local' }] }, [new LocalMeshTransport(peer.nodeId)])
    runtime = await import('./mesh-transport-runtime.js'); runtime.initMeshTransportRuntime()
})
afterAll(async () => { await runtime?.stopMeshTransportRuntime(); await sender?.close(); vi.unstubAllEnvs() })

async function publish(remoteAgentTools: unknown) {
    await sender.send('tools-main', sender.create('node.tools', 'tools-main', { tools: [{ name: 'read_file' }], inventoryHash: 'h', remoteAgentTools } as any))
}

describe('remote agent tools reported in node.tools', () => {
    it('stores the reported list per node', async () => {
        await publish(['find_files', 'read_file'])
        await vi.waitFor(() => expect(runtime.reportedRemoteAgentTools('tools-ns1')).toEqual(['find_files', 'read_file']))
        expect(runtime.reportedRemoteAgentTools('unknown-node')).toBeUndefined()
    })
    it('treats malformed lists as unknown', async () => {
        await publish(['read_file', 'rm -rf /'])
        await vi.waitFor(() => expect(runtime.reportedRemoteAgentTools('tools-ns1')).toBeUndefined())
    })
})
