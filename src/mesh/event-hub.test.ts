import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

// MI-3: the legacy hub has no authentication. It must stay on loopback,
// ignore events from unregistered sockets and never put owner memory on the wire.

async function freshHub() {
    vi.resetModules()
    return import('./event-hub.js')
}

function connect(port: number): Promise<{ ws: WebSocket; received: any[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        const received: any[] = []
        ws.on('message', raw => received.push(JSON.parse(raw.toString())))
        ws.on('open', () => resolve({ ws, received }))
        ws.on('error', reject)
    })
}
const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))

let hub: Awaited<ReturnType<typeof freshHub>> | null = null
afterEach(async () => { await hub?.stopMeshHub?.(); hub = null; vi.restoreAllMocks() })

describe('MI-3 legacy mesh event hub', () => {
    it('binds to loopback by default and refuses a wildcard bind', async () => {
        hub = await freshHub()
        const server = hub.startMeshHub(0) as any
        expect(server).toBeTruthy()
        await new Promise(resolve => server.address() ? resolve(null) : server.once('listening', resolve))
        expect((server.address() as AddressInfo).address).toBe('127.0.0.1')
        await hub.stopMeshHub()
        expect(hub.startMeshHub(0, '0.0.0.0')).toBeNull()
    })

    it('does not accept events from sockets that never registered', async () => {
        hub = await freshHub()
        const server = hub.startMeshHub(0) as any
        await new Promise(resolve => server.address() ? resolve(null) : server.once('listening', resolve))
        const port = (server.address() as AddressInfo).port
        const seen = vi.fn()
        hub.on('mesh:tool_registry', seen)
        const { ws } = await connect(port)
        ws.send(JSON.stringify({ type: 'mesh:tool_registry', data: { injected: true } }))
        await settle()
        expect(seen).not.toHaveBeenCalled()
        ws.close()
    })

    it.each([1791621712349, 1791621719999])('keeps memory shares local with timestamp %s while other events reach registered clients', async (timestamp) => {
        // A public timestamp can contain the same digits as a private value.
        // Check payload leakage independently, including the CI collision case.
        vi.spyOn(Date, 'now').mockReturnValue(timestamp)
        hub = await freshHub()
        const server = hub.startMeshHub(0) as any
        await new Promise(resolve => server.address() ? resolve(null) : server.once('listening', resolve))
        const port = (server.address() as AddressInfo).port
        const { ws, received } = await connect(port)
        ws.send(JSON.stringify({ type: 'mesh:register', data: { nodeId: 'listener' } }))
        await settle()
        const localMemory = vi.fn()
        hub.on('mesh:memory_share', localMemory)
        hub.emit('mesh:memory_share', { memory: { content: 'Owner PIN ist 1234' } })
        hub.emit('mesh:status_ping', { ok: true })
        await settle()
        expect(localMemory).toHaveBeenCalledTimes(1)
        expect(received.map(event => event.type)).toContain('mesh:status_ping')
        expect(received.map(event => event.type)).not.toContain('mesh:memory_share')
        expect(JSON.stringify(received)).not.toContain('Owner PIN ist 1234')
        expect(JSON.stringify(received.map(event => event.data))).not.toContain('1234')
        expect(received.find(event => event.type === 'mesh:status_ping')).toMatchObject({ data: { ok: true }, timestamp })
        ws.close()
    })
})
