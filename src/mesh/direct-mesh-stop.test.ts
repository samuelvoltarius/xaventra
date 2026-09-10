import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { DirectMeshTransport } from './direct-mesh-transport.js'
import { MeshIdentity } from './mesh-identity.js'

function transport() {
    return new DirectMeshTransport(new MeshIdentity('stop-fixture', mkdtempSync(join(tmpdir(), 'xaventra-stop-'))),
        { id: 'stop-fixture', role: 'system' }, { listenHost: '127.0.0.1', port: 0 })
}
async function listening(t: DirectMeshTransport) {
    t.start()
    for (let n = 0; n < 100 && !t.listeningPort(); n++) await new Promise(r => setTimeout(r, 10))
    expect(t.listeningPort()).toBeGreaterThan(0)
    return t.listeningPort()!
}
async function closes(t: DirectMeshTransport, within: number) {
    let timer: ReturnType<typeof setTimeout>
    try { return await Promise.race([t.close().then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), within) })]) }
    finally { clearTimeout(timer!) }
}

describe('Direct Mesh shutdown before update snapshot', () => {
    it('closes a connected client that has not sent a signed hello', async () => {
        const t = transport(), port = await listening(t), peer = new WebSocket(`ws://127.0.0.1:${port}`)
        try {
            await once(peer, 'open')
            expect(await closes(t, 500)).toBe(true)
            expect(t.health().healthy).toBe(false)
        } finally { peer.terminate(); await t.close() }
    })

    it('bounds the close handshake when a peer stops reading', async () => {
        const t = transport(), port = await listening(t), peer = new WebSocket(`ws://127.0.0.1:${port}`)
        try {
            await once(peer, 'open'); peer.pause()
            expect(await closes(t, 2500)).toBe(true)
            expect(t.listeningPort()).toBeNull()
        } finally { peer.resume(); peer.terminate(); await t.close() }
    })

    it('settles an unacknowledged outbound hello without claiming delivery', async () => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), t = transport()
        await once(server, 'listening')
        const address = server.address() as { port: number }
        const connected = once(server, 'connection')
        const result = t.connect({ nodeId: 'silent-peer', transport: 'direct', status: 'unknown', url: `ws://127.0.0.1:${address.port}` })
            .then(() => 'delivered', error => String(error))
        try {
            await connected
            expect(await closes(t, 500)).toBe(true)
            let timer: ReturnType<typeof setTimeout>
            const value = await Promise.race([result, new Promise<string>(r => { timer = setTimeout(() => r('still-pending'), 500) })])
            clearTimeout(timer!)
            expect(value).not.toBe('still-pending')
            expect(value).not.toBe('delivered')
            await expect(t.connect({ nodeId: 'late', transport: 'direct', status: 'unknown', url: `ws://127.0.0.1:${address.port}` })).rejects.toThrow('closed')
        } finally { for (const s of server.clients) s.terminate(); await t.close(); await new Promise<void>(r => server.close(() => r())); await result }
    })
})
