import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({ valid: true }))
const capture = vi.hoisted(() => vi.fn())
vi.mock('../host/capture-agent.js', () => ({ requestSessionCapture: capture }))
vi.mock('./fence-highwater.js', () => ({ checkDelegatedFence: async () => ({ ok: authority.valid, reason: 'fixture' }) }))
vi.mock('./fence.js', async original => ({ ...await original<typeof import('./fence.js')>(),
    assertFenced: vi.fn(async () => { if (!authority.valid) throw new Error('lease lost') }),
    getHeldFence: () => ({ service: 'nova-main', epoch: 7, fencingToken: 'fixture', authority: 'static' }),
}))
let runtime: typeof import('./mesh-transport-runtime.js')
let sender: import('./mesh-transport-router.js').MeshTransportRouter
const replies: import('./transport-contracts.js').MeshEnvelope[] = []
const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
beforeAll(async () => {
    vi.stubEnv('NOVA_NODE_ID', 'capture-worker')
    vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '1')
    vi.stubEnv('NOVA_CAPTURE_SOCKET', '/fixture/socket'); vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/fixture/token')
    capture.mockResolvedValue(image)
    const { MeshIdentity } = await import('./mesh-identity.js')
    const { MeshTransportRouter } = await import('./mesh-transport-router.js')
    const { LocalMeshTransport } = await import('./local-mesh-transport.js')
    const main = new MeshIdentity('capture-main', mkdtempSync(join(tmpdir(), 'capture-main-')))
    const worker = new MeshIdentity('capture-worker')
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'direct', direct: { enabled: false, peers: [{ nodeId: main.nodeId, publicKey: main.publicKey, roles: ['system'] }] } } }))
    sender = new MeshTransportRouter(main, { id: 'node:capture-main', role: 'system', channel: 'mesh' }, { mode: 'standalone', peers: [{ nodeId: worker.nodeId, publicKey: worker.publicKey, roles: ['system'], transport: 'local' }] }, [new LocalMeshTransport(main.nodeId)])
    sender.subscribe(e => { replies.push(e) })
    runtime = await import('./mesh-transport-runtime.js'); runtime.initMeshTransportRuntime()
})
afterAll(async () => { await runtime?.stopMeshTransportRuntime(); await sender?.close(); vi.unstubAllEnvs() })
async function request(withFence = true) {
    const e = sender.create('capture.request', 'capture-worker', { operation: 'capture', principalId: 'owner', runId: 'run' },
        withFence ? { fence: { service: 'nova-main', epoch: 7, token: 'fixture', authority: 'static' } } : {})
    await sender.send('capture-worker', e)
    await vi.waitFor(() => expect(replies.some(r => (r.payload as any).requestId === e.id)).toBe(true))
    return replies.find(r => (r.payload as any).requestId === e.id)!.payload as any
}
describe('signed capture through actual ephemeral runtime route', () => {
    it('accepts only the typed correlated response, never a generic run.result', async () => {
        authority.valid = true
        let requestId = ''
        sender.subscribe(async e => {
            if (e.kind !== 'capture.request') return
            requestId = e.id
            await sender.send('capture-worker', sender.create('run.result', 'capture-worker', { requestId: e.id, success: true, result: { base64: 'PRIVATE_PIXELS' } }))
            await sender.send('capture-worker', sender.create('capture.response', 'capture-worker', { requestId: e.id, success: true,
                result: { nodeId: 'capture-main', capturedAt: new Date().toISOString(), bytes: image.length,
                    sha256: createHash('sha256').update(image).digest('hex'), base64: image.toString('base64'), mimeType: 'image/png' } }))
        })
        expect(await runtime.requestNodeCapture('capture-main', { operation: 'capture', principalId: 'owner', runId: 'run' })).toMatchObject({ nodeId: 'capture-main', bytes: 24 })
        expect(runtime.getMeshRunResult(requestId)).toBeUndefined()
    })
    it('returns source and hash verified image, without general result-cache persistence', async () => {
        const result = await request()
        expect(result).toMatchObject({ success: true, result: { nodeId: 'capture-worker', sha256: createHash('sha256').update(image).digest('hex') } })
        expect(runtime.getMeshRunResult(result.requestId)).toBeUndefined()
    })
    it('rejects invalid Main authority and missing fence without capturing', async () => {
        capture.mockClear(); authority.valid = false
        expect(await request()).toMatchObject({ success: false })
        authority.valid = true
        expect(await request(false)).toMatchObject({ success: false })
        expect(capture).not.toHaveBeenCalled()
    })
})
