import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Späher: the report travels as a signed mesh envelope. Main hands only verified,
// well-formed reports of a known peer to sensing; a tampered (unsigned) or observer
// report is dropped.
const ingest = vi.hoisted(() => vi.fn(async () => ({ recorded: 1, rejected: 0 })))
vi.mock('../sensing/runtime.js', async importOriginal => ({ ...(await importOriginal<object>()), ingestScoutReport: ingest }))

let runtime: typeof import('./mesh-transport-runtime.js')
let scout: import('./mesh-transport-router.js').MeshTransportRouter
let observer: import('./mesh-transport-router.js').MeshTransportRouter
const payload = { subnets: ['192.168.1.0/24'], hasTailnet: false, candidates: [{ type: 'homeassistant', host: '192.168.1.20', port: 8123, via: 'http' }] }
beforeAll(async () => {
    vi.stubEnv('NOVA_NODE_ID', 'scout-main')
    vi.stubEnv('NOVA_NODE_ONLY', '')
    vi.stubEnv('NOVA_RUNTIME_ROOT', mkdtempSync(join(tmpdir(), 'scout-main-root-')))
    const { MeshIdentity } = await import('./mesh-identity.js')
    const { MeshTransportRouter } = await import('./mesh-transport-router.js')
    const { LocalMeshTransport } = await import('./local-mesh-transport.js')
    const nas = new MeshIdentity('scout-nas', mkdtempSync(join(tmpdir(), 'scout-nas-')))
    const watcher = new MeshIdentity('scout-watcher', mkdtempSync(join(tmpdir(), 'scout-watcher-')))
    const main = new MeshIdentity('scout-main')
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ mesh: { mode: 'direct', direct: { enabled: false, peers: [
        { nodeId: nas.nodeId, publicKey: nas.publicKey, roles: ['worker'] },
        { nodeId: watcher.nodeId, publicKey: watcher.publicKey, roles: ['observer'] },
    ] } } }))
    const route = (id: any, principal: any) => new MeshTransportRouter(id, principal, { mode: 'standalone', peers: [{ nodeId: main.nodeId, publicKey: main.publicKey, roles: ['system'], transport: 'local' }] }, [new LocalMeshTransport(id.nodeId)])
    scout = route(nas, { id: 'node:scout-nas', role: 'worker', channel: 'mesh' })
    observer = route(watcher, { id: 'node:scout-watcher', role: 'observer', channel: 'mesh' })
    runtime = await import('./mesh-transport-runtime.js'); runtime.initMeshTransportRuntime()
})
afterAll(async () => { await runtime?.stopMeshTransportRuntime(); await scout?.close(); await observer?.close(); vi.unstubAllEnvs() })
beforeEach(() => ingest.mockClear())

describe('signed discovery.report', () => {
    it('a verified report of the scout reaches sensing on Main', async () => {
        await scout.send('scout-main', scout.create('discovery.report', 'scout-main', payload))
        await vi.waitFor(() => expect(ingest).toHaveBeenCalledWith('scout-nas', payload))
    })
    it('Gegenprobe: a report changed after signing is dropped', async () => {
        const envelope = scout.create('discovery.report', 'scout-main', payload)
        ;(envelope.payload as any).candidates[0].host = '192.168.1.66'
        await scout.send('scout-main', envelope).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(ingest).not.toHaveBeenCalled()
    })
    it('Gegenprobe: an observer may not report', async () => {
        await observer.send('scout-main', observer.create('discovery.report', 'scout-main', payload)).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(ingest).not.toHaveBeenCalled()
    })
    it('Gegenprobe: a malformed report is dropped', async () => {
        await scout.send('scout-main', scout.create('discovery.report', 'scout-main', { ...payload, subnets: ['8.8.8.0/24'] })).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(ingest).not.toHaveBeenCalled()
    })
})
