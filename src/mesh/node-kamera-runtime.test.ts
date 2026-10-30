import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Kamera anbinden: the login travels in a signed capture.request (ephemeral: encrypted direct or
// local only, never relay, Supabase or the outbox), fenced by Main, replay protected, with a short
// lifetime. The camera address must be in the node's own network. The password is in no log.
const authority = vi.hoisted(() => ({ valid: true }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(),
    networkInterfaces: () => ({ eth0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }) }))
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('../sensing/camera-client.js', async original => ({ ...await original<object>(), onvifSnapshot: snapshot }))
vi.mock('./fence-highwater.js', () => ({ checkDelegatedFence: async () => ({ ok: authority.valid, reason: 'fixture' }) }))
vi.mock('./fence.js', async original => ({ ...await original<typeof import('./fence.js')>(),
    assertFenced: vi.fn(async () => { if (!authority.valid) throw new Error('lease lost') }),
    getHeldFence: () => ({ service: 'nova-main', epoch: 7, fencingToken: 'fixture', authority: 'static' }),
}))
const PASSWORT = ['fixture', 'kamera', String(4711), 'x'].join('-')
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(32)])
let runtime: typeof import('./mesh-transport-runtime.js')
let sender: import('./mesh-transport-router.js').MeshTransportRouter
const replies: import('./transport-contracts.js').MeshEnvelope[] = []
const logged: string[] = []
const payload = (host = '192.168.1.60') => ({ operation: 'kamera', principalId: 'owner', runId: 'run', kamera: { host, port: 8000 }, zugang: { benutzer: 'betrachter', passwort: PASSWORT } })
const FENCE = { fence: { service: 'nova-main', epoch: 7, token: 'fixture', authority: 'static' } }

beforeAll(async () => {
    vi.stubEnv('NOVA_NODE_ID', 'kamera-worker')
    vi.stubEnv('NOVA_RUNTIME_ROOT', mkdtempSync(join(tmpdir(), 'kamera-worker-')))
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    const { MeshIdentity } = await import('./mesh-identity.js')
    const { MeshTransportRouter } = await import('./mesh-transport-router.js')
    const { LocalMeshTransport } = await import('./local-mesh-transport.js')
    const main = new MeshIdentity('kamera-main', mkdtempSync(join(tmpdir(), 'kamera-main-')))
    const worker = new MeshIdentity('kamera-worker')
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'direct', direct: { enabled: false, peers: [{ nodeId: main.nodeId, publicKey: main.publicKey, roles: ['system'] }] } } }))
    sender = new MeshTransportRouter(main, { id: 'node:kamera-main', role: 'system', channel: 'mesh' }, { mode: 'standalone', peers: [{ nodeId: worker.nodeId, publicKey: worker.publicKey, roles: ['system'], transport: 'local' }] }, [new LocalMeshTransport(main.nodeId)])
    sender.subscribe(e => { replies.push(e) })
    runtime = await import('./mesh-transport-runtime.js'); runtime.initMeshTransportRuntime()
})
afterAll(async () => { await runtime?.stopMeshTransportRuntime(); await sender?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
afterEach(() => { snapshot.mockReset(); authority.valid = true })

async function send(body: unknown = payload(), options: Record<string, unknown> = FENCE) {
    const e = sender.create('capture.request', 'kamera-worker', body, options)
    await sender.send('kamera-worker', e)
    await vi.waitFor(() => expect(replies.some(r => (r.payload as any).requestId === e.id)).toBe(true))
    return { reply: replies.find(r => (r.payload as any).requestId === e.id)!.payload as any, envelope: e }
}

describe('camera still over the signed mesh route', () => {
    it('fetches for the given address and answers with a hash-bound image', async () => {
        snapshot.mockResolvedValue(JPEG)
        const { reply } = await send()
        expect(reply).toMatchObject({ success: true, result: { nodeId: 'kamera-worker', mimeType: 'image/jpeg', sha256: createHash('sha256').update(JPEG).digest('hex') } })
        expect(snapshot).toHaveBeenCalledWith({ host: '192.168.1.60', port: 8000 }, { benutzer: 'betrachter', passwort: PASSWORT })
        expect(runtime.getMeshRunResult(reply.requestId)).toBeUndefined()
    })
    it('Gegenprobe: an address outside the own network is refused before any request', async () => {
        const { reply } = await send(payload('8.8.8.8'))
        expect(reply.success).toBe(false)
        expect(snapshot).not.toHaveBeenCalled()
    })
    it('Gegenprobe: no valid Main authority or no fence, no camera request', async () => {
        authority.valid = false
        expect((await send()).reply.success).toBe(false)
        authority.valid = true
        expect((await send(payload(), {})).reply.success).toBe(false)
        expect(snapshot).not.toHaveBeenCalled()
    })
    it('a repeated envelope (replay) is not executed twice', async () => {
        snapshot.mockResolvedValue(JPEG)
        const { envelope } = await send()
        await sender.send('kamera-worker', envelope).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 200))
        expect(snapshot).toHaveBeenCalledOnce()
    })
    it('a camera error stays a fixed sentence; the password is in no reply and no log', async () => {
        const { CameraError } = await import('../sensing/camera-client.js')
        snapshot.mockRejectedValue(new CameraError('Die Kamera hat die Anmeldung abgelehnt.'))
        const { reply } = await send()
        expect(reply).toMatchObject({ success: false })
        expect(reply.error).toContain('Die Kamera hat die Anmeldung abgelehnt.')
        expect(JSON.stringify(reply)).not.toContain(PASSWORT)
        expect(logged.join('\n')).not.toContain(PASSWORT)
    })
    it('the password lands in no file of the node (replay cache, outbox, audit)', async () => {
        snapshot.mockResolvedValue(JPEG)
        await send()
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
        for (const path of walk(process.env.NOVA_RUNTIME_ROOT!)) expect(readFileSync(path, 'latin1').includes(PASSWORT), path).toBe(false)
    })
    it('Main: without a path to the node it ends with an error, nothing else is tried', async () => {
        await expect(runtime.requestNodeKamera('kein-solcher-knoten', payload() as any)).rejects.toThrow()
        expect(snapshot).not.toHaveBeenCalled()
    })
    it('kinds of this route never go through relay, Supabase or the outbox', async () => {
        const { isEphemeralMeshKind } = await import('./transport-contracts.js')
        expect(isEphemeralMeshKind('capture.request')).toBe(true)
        expect(isEphemeralMeshKind('capture.response')).toBe(true)
    })
    it('a malformed login is no valid request', async () => {
        const { validNodeCaptureRequest } = await import('./node-capture.js')
        expect(validNodeCaptureRequest(payload())).toBe(true)
        expect(validNodeCaptureRequest({ ...payload(), zugang: { benutzer: 'a' } })).toBe(false)
        expect(validNodeCaptureRequest({ ...payload(), kamera: { host: 'cam.local', port: 80 } })).toBe(false)
        expect(validNodeCaptureRequest({ ...payload(), extra: 1 })).toBe(false)
    })
})
