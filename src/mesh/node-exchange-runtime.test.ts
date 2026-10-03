import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { getRuntimeRoot } from '../core/data-root.js'

const authority = vi.hoisted(() => ({ valid: true, checks: 0, loseAtCommit: false }))
vi.mock('./fence-highwater.js', () => ({ checkDelegatedFence: async () => {
    authority.checks++
    return { ok: authority.valid && !(authority.loseAtCommit && authority.checks > 1), reason: 'fixture authority' }
} }))
vi.mock('./fence.js', async importOriginal => ({
    ...await importOriginal<typeof import('./fence.js')>(),
    assertFenced: vi.fn(async () => ({ ok: true })),
    getHeldFence: () => ({ service: 'nova-main', epoch: 7, fencingToken: 'fixture-fence', authority: 'static' }),
}))
let runtime: typeof import('./mesh-transport-runtime.js')
let sender: import('./mesh-transport-router.js').MeshTransportRouter
const replies: import('./transport-contracts.js').MeshEnvelope[] = []
const fence = { service: 'nova-main', epoch: 7, token: 'fixture-fence', authority: 'static' as const }
const bytes = Buffer.from('signed exchange fixture')
const payload = (name: string) => ({ operation: 'write' as const, name, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })

beforeAll(async () => {
    process.env.NOVA_NODE_ID = 'exchange-worker'
    vi.resetModules()
    const { MeshIdentity } = await import('./mesh-identity.js')
    const { MeshTransportRouter } = await import('./mesh-transport-router.js')
    const { LocalMeshTransport } = await import('./local-mesh-transport.js')
    const main = new MeshIdentity('exchange-main', mkdtempSync(join(tmpdir(), 'exchange-main-')))
    const worker = new MeshIdentity('exchange-worker')
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'direct', direct: { enabled: false, peers: [{ nodeId: main.nodeId, publicKey: main.publicKey, roles: ['system'] }] } } }))
    sender = new MeshTransportRouter(main, { id: 'node:exchange-main', role: 'system', channel: 'mesh' }, { mode: 'standalone', peers: [{ nodeId: worker.nodeId, publicKey: worker.publicKey, roles: ['system'], transport: 'local' }] }, [new LocalMeshTransport(main.nodeId)])
    sender.subscribe(envelope => { replies.push(envelope) })
    runtime = await import('./mesh-transport-runtime.js')
    runtime.initMeshTransportRuntime()
})
afterAll(async () => { await runtime?.stopMeshTransportRuntime(); await sender?.close(); delete process.env.NOVA_NODE_ID })

async function request(body: unknown, withFence = true) {
    authority.checks = 0
    const envelope = sender.create('exchange.request', 'exchange-worker', body, { ...(withFence ? { fence } : {}) })
    await sender.send('exchange-worker', envelope)
    return replies.find(reply => (reply.payload as any)?.requestId === envelope.id)?.payload as any
}

describe('signed exchange request through the actual runtime router', () => {
    it('writes and confirms the requested file, then handles an identical retry', async () => {
        authority.valid = true; authority.loseAtCommit = false
        const result = await request(payload('signed.md'))
        expect(result).toMatchObject({ success: true, result: { name: 'signed.md', bytes: bytes.length, sha256: payload('signed.md').sha256 } })
        expect((await request(payload('signed.md'))).result).toEqual(result.result)
        const inventory = await request({ operation: 'list' })
        expect(inventory.result.files).toContainEqual({ name: 'signed.md', bytes: bytes.length })
    })
    it('enforces Main authority even in observe mode, including before commit', async () => {
        authority.valid = false
        expect(await request(payload('denied.md'))).toMatchObject({ success: false })
        authority.valid = true; authority.loseAtCommit = true
        expect(await request(payload('lost.md'))).toMatchObject({ success: false })
        authority.loseAtCommit = false
        expect(await request(payload('unfenced.md'), false)).toMatchObject({ success: false })
        const { executeExchange } = await import('./node-exchange.js')
        const inventory = await executeExchange({ operation: 'list' }, getRuntimeRoot())
        expect(inventory).toEqual({ files: [{ name: 'signed.md', bytes: bytes.length }] })
    })
    it('requires an actual typed response and rejects a signed but malformed peer result', async () => {
        let malformed = true
        sender.subscribe(async envelope => {
            if (envelope.kind !== 'exchange.request') return
            // A generic run.result must not resolve an exchange, even from the correct peer.
            await sender.send('exchange-worker', sender.create('run.result', 'exchange-worker', { requestId: envelope.id, success: true, result: { files: [{ name: 'wrong.md', bytes: 1 }] } }))
            await sender.send('exchange-worker', sender.create('exchange.response', 'exchange-worker', { requestId: envelope.id, success: malformed ? 'true' : true, result: { files: [{ name: 'peer.md', bytes: 1 }] } }))
        })
        await expect(runtime.requestNodeExchange('exchange-main', { operation: 'list' })).rejects.toThrow('no confirmed success')
        malformed = false
        expect(await runtime.requestNodeExchange('exchange-main', { operation: 'list' })).toEqual({ files: [{ name: 'peer.md', bytes: 1 }] })
        const { assertFenced } = await import('./fence.js')
        expect(assertFenced).toHaveBeenCalledWith('nova-main', expect.objectContaining({ live: true, mode: 'enforce' }))
    })
})
