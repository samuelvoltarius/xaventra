import { request } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { isDashboardOwnerOnlyPath, isDashboardOwnerRequest, isLoopbackAddress, isLoopbackHostHeader } from './access-guard.js'

// INT-10 regression: the dashboard has no login. Memory search (unscoped
// LanceDB recall), conversations, config and the live WebSocket feed were
// served to any peer that could reach the port, and to foreign web pages via
// DNS rebinding / cross-site WebSocket. They are now owner-only: loopback
// peer plus loopback Host/Origin.

describe('dashboard access guard (INT-10)', () => {
    it('recognises loopback peers only', () => {
        for (const ip of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip), ip).toBe(true)
        for (const ip of ['100.86.70.71', '192.168.0.2', '::ffff:10.0.0.1', '', undefined, '1127.0.0.1']) expect(isLoopbackAddress(ip as any), String(ip)).toBe(false)
    })

    it('accepts only loopback Host headers (DNS rebinding)', () => {
        for (const host of ['localhost:3011', '127.0.0.1:3011', '[::1]:3011', 'LOCALHOST', '127.0.0.1']) expect(isLoopbackHostHeader(host), host).toBe(true)
        for (const host of ['evil.example:3011', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined]) expect(isLoopbackHostHeader(host as any), String(host)).toBe(false)
    })

    it('requires loopback peer, loopback host and no foreign origin', () => {
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3011' })).toBe(true)
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: 'localhost:3011', origin: 'http://localhost:3011' })).toBe(true)
        expect(isDashboardOwnerRequest({ remoteAddress: '100.86.70.71', host: '127.0.0.1:3011' })).toBe(false)
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: 'rebound.evil.example:3011' })).toBe(false)
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3011', origin: 'https://evil.example' })).toBe(false)
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3011', origin: 'null' })).toBe(false)
    })

    it('classifies memory/conversation/config routes as owner-only', () => {
        for (const path of ['/api/memory/search', '/api/memory', '/api/chat/sessions/x', '/api/sessions', '/api/core-facts', '/api/config', '/api/graph', '/api/journal'])
            expect(isDashboardOwnerOnlyPath(path), path).toBe(true)
        for (const path of ['/api/stats', '/api/performance', '/api/desktop/bootstrap', '/api/chatter', '/'])
            expect(isDashboardOwnerOnlyPath(path), path).toBe(false)
    })
})

describe('dashboard server enforces the guard (INT-10)', () => {
    let url = ''
    let stop: () => Promise<void> = async () => undefined
    let token = ''
    const sandbox = join(process.cwd(), '.nova-test-tmp', `dashboard-guard-${randomUUID()}`)

    beforeAll(async () => {
        mkdirSync(sandbox, { recursive: true })
        vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
        const server = await import('./server.js')
        url = await server.startDashboard(0, '127.0.0.1')
        stop = server.stopDashboard
        // R2 C-1: every API call and the live feed now also need the owner token.
        token = (await import('../infra/gateway-auth.js')).getGatewayAuth().token || ''
    }, 60_000)
    afterAll(async () => { await stop(); vi.restoreAllMocks() })

    const get = (path: string, host: string) => new Promise<number>((resolve, reject) => {
        const target = new URL(path, url)
        const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers: { host, authorization: `Bearer ${token}` } }, res => {
            res.resume()
            resolve(res.statusCode || 0)
        })
        req.on('error', reject)
        req.end()
    })

    it('rejects memory search under a rebound (foreign) Host header', async () => {
        expect(await get('/api/memory/search?q=x', 'rebound.evil.example')).toBe(403)
        expect(await get('/api/chat/sessions', 'rebound.evil.example')).toBe(403)
    })

    it('serves owner data to a genuine local request', async () => {
        const target = new URL(url)
        expect(await get('/api/sessions', `127.0.0.1:${target.port}`)).toBe(200)
    })

    it('refuses a WebSocket from a foreign browser origin but accepts a local one', async () => {
        const wsUrl = url.replace(/^http/, 'ws')
        const outcome = (origin: string) => new Promise<string>(resolve => {
            const ws = new WebSocket(wsUrl, { origin, headers: { authorization: `Bearer ${token}` } })
            ws.on('open', () => { ws.close(); resolve('open') })
            ws.on('unexpected-response', (_req, res) => { resolve(`http-${res.statusCode}`) })
            ws.on('error', () => resolve('error'))
        })
        expect(await outcome('https://evil.example')).not.toBe('open')
        expect(await outcome(new URL(url).origin)).toBe('open')
    })
})
