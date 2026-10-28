import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCPClient } from './mcp-client.js'

// B2 (28.10.2026, VM 130): 13.256× in 13 h
// "[L0] Unhandled Rejection: Error [ERR_UNHANDLED_ERROR]: Unhandled error. ({ server: 'home-assistant',
//  error: "MCP home-assistant connection failed: Unhandled error. ({ server: 'home-assistant', error: 'fetch failed' })" })
//  at MCPClient.emit (node:events) at dist/mcp/mcp-client.js:315"
const haConfig = (fetch: any) => ({
    name: 'home-assistant', transport: 'http' as const, url: 'http://192.168.0.30:8123/api/mcp', allowLanHttp: true, fetch,
})
const unreachable = () => vi.fn(async () => { throw new TypeError('fetch failed') })

describe('MCP gateway: unreachable server (B2)', () => {
    afterEach(() => { vi.useRealTimers() })

    it('reports the network error itself, never an unhandled EventEmitter error', async () => {
        const client = new MCPClient()
        const failure = await client.connectServer(haConfig(unreachable())).catch(error => error as Error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toContain('fetch failed')
        expect(failure.message).not.toMatch(/Unhandled error/)
        client.disconnectAll()
    })

    it('retries with growing pauses up to 10 min and reports the outage exactly once', async () => {
        vi.useFakeTimers()
        const rejections: unknown[] = []
        const onRejection = (reason: unknown) => { rejections.push(reason) }
        process.on('unhandledRejection', onRejection)
        try {
            const fetch = unreachable()
            const client = new MCPClient()
            const outages: unknown[] = []
            client.on('unreachable', info => outages.push(info))
            await client.connectServer(haConfig(fetch)).catch(() => undefined)
            client.scheduleReconnect('home-assistant', haConfig(fetch))
            // 13 h like the live log: the old loop made ~13.000 attempts.
            for (let minute = 0; minute < 13 * 60; minute++) await vi.advanceTimersByTimeAsync(60_000)
            const attempts = fetch.mock.calls.length
            expect(attempts).toBeGreaterThan(5)
            // 10-min cap → at most ~6 per hour after the ramp-up.
            expect(attempts).toBeLessThan(13 * 6 + 20)
            expect(outages).toHaveLength(1)
            expect(outages[0]).toMatchObject({ server: 'home-assistant', address: 'http://192.168.0.30:8123' })
            client.disconnectAll()
        } finally {
            process.off('unhandledRejection', onRejection)
        }
        expect(rejections).toEqual([])
    })

    it('stops retrying after an explicit disconnect', async () => {
        vi.useFakeTimers()
        const fetch = unreachable()
        const client = new MCPClient()
        await client.connectServer(haConfig(fetch)).catch(() => undefined)
        client.scheduleReconnect('home-assistant', haConfig(fetch))
        client.disconnect('home-assistant')
        const before = fetch.mock.calls.length
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(fetch.mock.calls.length).toBe(before)
    })
})
