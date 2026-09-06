import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { dashboardAddress, listenDashboard } from './listener.js'

describe('Dashboard bind contract', () => {
    it('binds loopback and reports the actual selected port', async () => {
        const server = createServer((_req, res) => res.end('isolated'))
        expect(dashboardAddress(server)).toBeNull()
        try {
            const url = await listenDashboard(server, 0)
            expect((server.address() as any).address).toBe('127.0.0.1')
            expect(dashboardAddress(server)).toBe(url)
            expect(await (await fetch(url)).text()).toBe('isolated')
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
        expect(dashboardAddress(server)).toBeNull()
    })
    it('rejects an occupied port instead of starting a different control plane', async () => {
        const first = createServer(), second = createServer()
        const existingListeners = second.listenerCount('listening')
        try {
            await listenDashboard(first, 0)
            await expect(listenDashboard(second, (first.address() as any).port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
            expect(second.listening).toBe(false)
            expect(second.listenerCount('listening')).toBe(existingListeners)
        } finally { await new Promise<void>(resolve => first.close(() => resolve())) }
    })
})
