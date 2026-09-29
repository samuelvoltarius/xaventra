import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { startRestApi } from './rest-api.js'
import { reconcileConfiguredOwner, type UserRecord } from '../users/multi-user-middleware.js'

// K1 regression: the REST principal must never be chosen by the request body,
// the listener must not be reachable cross-origin, and unauthenticated loopback
// use must reject DNS-rebinding Host headers.

let server: Server | undefined
afterEach(async () => {
    vi.unstubAllEnvs()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
})

async function start() {
    const handler = vi.fn(async (_channel: string, _from: string, _content: string, reply: (msg: string) => Promise<void>) => { await reply('ok') })
    server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, handler, () => ({ version: 'test' }))
    return { port: (server.address() as any).port as number, handler }
}

function raw(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: options.method || 'GET', path: options.path, headers: options.headers }, res => {
            let body = ''
            res.on('data', chunk => { body += chunk })
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers as any, body }))
        })
        req.on('error', reject)
        if (options.body) req.write(options.body)
        req.end()
    })
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('REST API identity and browser exposure (K1)', () => {
    it('ignores channel/from supplied in the body and uses the token-derived principal', async () => {
        vi.stubEnv('NOVA_API_TOKEN', 'synthetic-identity-token')
        const { port, handler } = await start()
        const res = await raw(port, {
            method: 'POST', path: '/v1/message',
            headers: { ...JSON_HEADERS, Authorization: 'Bearer synthetic-identity-token' },
            body: JSON.stringify({ content: 'hi', channel: 'telegram', from: '123456789' }),
        })
        expect(res.status).toBe(200)
        expect(handler).toHaveBeenCalledWith('rest-api', 'rest-api:token', 'hi', expect.any(Function))
    })

    it('uses a fixed unauthenticated principal on loopback without token, even for cli/internal claims', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port, handler } = await start()
        const res = await raw(port, {
            method: 'POST', path: '/v1/message', headers: JSON_HEADERS,
            body: JSON.stringify({ content: 'hi', channel: 'cli', from: 'cli' }),
        })
        expect(res.status).toBe(200)
        expect(handler).toHaveBeenCalledWith('rest-api', 'rest-api:local', 'hi', expect.any(Function))
    })

    it('does not send a wildcard CORS header and does not approve preflights', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port } = await start()
        const health = await raw(port, { path: '/v1/health' })
        expect(health.status).toBe(200)
        expect(health.headers['access-control-allow-origin']).toBeUndefined()
        const preflight = await raw(port, { method: 'OPTIONS', path: '/v1/message', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
        expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
        expect(preflight.status).toBeGreaterThanOrEqual(400)
    })

    it('rejects browser simple POSTs (non-JSON content type) before the pipeline', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port, handler } = await start()
        const res = await raw(port, { method: 'POST', path: '/v1/message', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ content: 'hi' }) })
        expect(res.status).toBe(415)
        expect(handler).not.toHaveBeenCalled()
    })

    it('rejects cross-origin requests even when they carry JSON', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port, handler } = await start()
        const res = await raw(port, { method: 'POST', path: '/v1/message', headers: { ...JSON_HEADERS, Origin: 'https://evil.example' }, body: JSON.stringify({ content: 'hi' }) })
        expect(res.status).toBe(403)
        expect(handler).not.toHaveBeenCalled()
    })

    it('rejects non-loopback Host headers without a token (DNS rebinding)', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port, handler } = await start()
        const res = await raw(port, { method: 'POST', path: '/v1/message', headers: { ...JSON_HEADERS, Host: `rebind.evil.example:${port}` }, body: JSON.stringify({ content: 'hi' }) })
        expect(res.status).toBe(403)
        expect(handler).not.toHaveBeenCalled()
        const status = await raw(port, { path: '/v1/status', headers: { Host: 'rebind.evil.example' } })
        expect(status.status).toBe(403)
    })

    it('accepts loopback Host header variants without a token', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { port } = await start()
        for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost']) {
            expect((await raw(port, { path: '/v1/status', headers: { Host: host } })).status).toBe(200)
        }
    })

    it('rejects a wrong token of equal and different length', async () => {
        vi.stubEnv('NOVA_API_TOKEN', 'synthetic-identity-token')
        const { port, handler } = await start()
        for (const token of ['synthetic-identity-tokeX', 'short', '']) {
            const res = await raw(port, { method: 'POST', path: '/v1/message', headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: 'hi' }) })
            expect(res.status).toBe(401)
        }
        expect(handler).not.toHaveBeenCalled()
    })

    it('never lets an unauthenticated REST principal hold owner/admin rights', () => {
        const base: UserRecord = { id: 'rest-api:local', permission: 'admin', permissionSource: 'explicit', firstSeen: 0, lastSeen: 0, messageCount: 0, channel: 'rest-api', onboarded: true }
        expect(reconcileConfiguredOwner(base, []).user.permission).toBe('user')
        expect(reconcileConfiguredOwner({ ...base, permission: 'owner' }, ['1']).user.permission).toBe('user')
        // A token-authenticated principal keeps an explicit operator grant.
        expect(reconcileConfiguredOwner({ ...base, id: 'rest-api:token' }, []).user.permission).toBe('admin')
    })
})
