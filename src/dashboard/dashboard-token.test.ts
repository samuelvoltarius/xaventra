import { request } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
    dashboardTokenFromHeaders, isAllowedDashboardHost, isDashboardOwnerRequest, isSameOriginRequest, isValidDashboardToken,
} from './access-guard.js'
import { buildNodeUpdateCommand, resolveMeshBundleUrl } from './mesh-update.js'

// R2 C-1 / H-1 / H-2 / H-3 / N-4 regressions. Before: the live feed and every
// API route were open to any local process (and via DNS rebinding / a
// cross-site page to any web page), GET /api/config returned secrets, the
// node update command was built from the request Host header, and a session
// id could name a path outside .nova-sessions.

const delegateTask = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1' })))
vi.mock('../mesh/mesh-registry.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../mesh/mesh-registry.js')>()),
    delegateTask,
}))

describe('dashboard token helpers', () => {
    it('reads the token from bearer, header or cookie', () => {
        expect(dashboardTokenFromHeaders({ authorization: 'Bearer abc' })).toBe('abc')
        expect(dashboardTokenFromHeaders({ 'x-nova-dashboard-token': 'def' })).toBe('def')
        expect(dashboardTokenFromHeaders({ cookie: 'a=1; nova_dashboard_token=ghi; b=2' })).toBe('ghi')
        expect(dashboardTokenFromHeaders({})).toBe('')
    })

    it('never accepts an empty, short or different token', () => {
        const expected = 'a'.repeat(64)
        expect(isValidDashboardToken(expected, expected)).toBe(true)
        expect(isValidDashboardToken('', expected)).toBe(false)
        expect(isValidDashboardToken('a'.repeat(63) + 'b', expected)).toBe(false)
        expect(isValidDashboardToken('', '')).toBe(false)
        expect(isValidDashboardToken('short', 'short')).toBe(false)
        expect(isValidDashboardToken('ä'.repeat(64), expected)).toBe(false)
    })

    it('allows loopback or the configured bind host only', () => {
        expect(isAllowedDashboardHost('127.0.0.1:3011')).toBe(true)
        expect(isAllowedDashboardHost('rebound.evil.example:3011')).toBe(false)
        expect(isAllowedDashboardHost('100.64.0.10:3011')).toBe(false)
        expect(isAllowedDashboardHost('100.64.0.10:3011', ['100.64.0.10'])).toBe(true)
    })

    it('treats another local port as a foreign origin', () => {
        expect(isSameOriginRequest('localhost:3011', 'http://localhost:3011')).toBe(true)
        expect(isSameOriginRequest('localhost:3011', 'http://localhost:5173')).toBe(false)
        expect(isDashboardOwnerRequest({ remoteAddress: '127.0.0.1', host: 'localhost:3011', origin: 'http://localhost:5173' })).toBe(false)
    })
})

describe('mesh node update command (H-3)', () => {
    it('takes the bundle URL only from configuration and rejects shell syntax', () => {
        expect(resolveMeshBundleUrl({}, {})).toBeNull()
        expect(resolveMeshBundleUrl({ dashboard: { bundleUrl: 'http://100.64.0.10:3011/api/mesh/bundle' } }, {})).toBe('http://100.64.0.10:3011/api/mesh/bundle')
        for (const bad of ['http://x";id;"/b', "http://x/'$(id)'", 'http://x/a?b=1', 'http://u:p@x/b', 'file:///etc/passwd', 'http://x/a b', 'http://x/`id`'])
            expect(resolveMeshBundleUrl({}, { NOVA_MESH_BUNDLE_URL: bad }), bad).toBeNull()
        expect(() => buildNodeUpdateCommand('http://x/$(id)')).toThrow()
        expect(buildNodeUpdateCommand('http://100.64.0.10:3011/api/mesh/bundle')).toContain("curl -sfL 'http://100.64.0.10:3011/api/mesh/bundle'")
    })
})

describe('dashboard server requires the owner token (C-1, H-1, H-2)', () => {
    let url = ''
    let port = ''
    let token = ''
    let stop: () => Promise<void> = async () => undefined
    const sandbox = join(process.cwd(), '.nova-test-tmp', `dashboard-token-${randomUUID()}`)

    beforeAll(async () => {
        mkdirSync(join(sandbox, '.nova-sessions'), { recursive: true })
        mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
        writeFileSync(join(sandbox, 'xaventra.config.json'), JSON.stringify({
            channels: { telegram: { enabled: true, token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', allowFrom: ['111'] } },
        }))
        writeFileSync(join(sandbox, '.nova-data', 'outside.json'), JSON.stringify({ type: 'message', content: 'outside-secret' }) + '\n')
        vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
        const server = await import('./server.js')
        url = await server.startDashboard(0, '127.0.0.1')
        port = new URL(url).port
        stop = server.stopDashboard
        token = (await import('../infra/gateway-auth.js')).getGatewayAuth().token || ''
    }, 60_000)
    afterAll(async () => { await stop(); vi.restoreAllMocks() })
    beforeEach(() => { delegateTask.mockClear(); delete process.env.NOVA_MESH_BUNDLE_URL })

    type Reply = { status: number; body: string; headers: Record<string, any> }
    const send = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<Reply>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = request({
            hostname: '127.0.0.1', port, path, method,
            headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
        }, res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }))
        })
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
    const auth = () => ({ authorization: `Bearer ${token}` })

    it('has a real token to test against', () => {
        expect(token.length).toBeGreaterThanOrEqual(32)
    })

    it('refuses API reads and writes without the token', async () => {
        for (const path of ['/api/status', '/api/stats', '/api/config', '/api/logs', '/api/mesh/nodes', '/api/scheduler', '/api/desktop/bootstrap'])
            expect((await send('GET', path)).status, path).toBe(401)
        for (const path of ['/api/mesh/delegate', '/api/mesh/update-node', '/api/doctor', '/api/tasks'])
            expect((await send('POST', path, {}, { targetNode: 'n', task: 'x' })).status, path).toBe(401)
        expect(delegateTask).not.toHaveBeenCalled()
        expect((await send('GET', '/api/stats', { authorization: 'Bearer wrong' })).status).toBe(401)
        expect((await send('GET', '/api/stats', auth())).status).toBe(200)
    })

    it('refuses a DNS-rebound Host and a foreign Origin even with the token', async () => {
        expect((await send('GET', '/api/stats', { ...auth(), host: 'rebound.evil.example:' + port })).status).toBe(403)
        expect((await send('POST', '/api/doctor', { ...auth(), origin: 'http://evil.example' })).status).toBe(403)
        expect((await send('POST', '/api/doctor', { ...auth(), origin: 'http://localhost:5173' })).status).toBe(403)
    })

    it('exchanges ?token= for an HttpOnly SameSite=Strict cookie that then works', async () => {
        expect((await send('GET', '/')).status).toBe(401)
        expect((await send('GET', '/?token=wrong')).status).toBe(401)
        const login = await send('GET', `/?token=${token}`)
        expect(login.status).toBe(303)
        const cookie = String(login.headers['set-cookie']?.[0] || '')
        expect(cookie).toMatch(/HttpOnly/)
        expect(cookie).toMatch(/SameSite=Strict/)
        const pair = cookie.split(';')[0]
        expect((await send('GET', '/', { cookie: pair })).status).toBe(200)
        expect((await send('GET', '/api/stats', { cookie: pair })).status).toBe(200)
        // The static shell itself holds no data.
        expect((await send('GET', '/app.js')).status).toBe(200)
    })

    it('opens the live feed only with the token', async () => {
        const wsUrl = url.replace(/^http/, 'ws')
        const outcome = (target: string, headers: Record<string, string> = {}, origin = new URL(url).origin) => new Promise<string>(resolve => {
            const ws = new WebSocket(target, { origin, headers })
            ws.on('open', () => { ws.close(); resolve('open') })
            ws.on('unexpected-response', (_req, res) => { resolve(`http-${res.statusCode}`) })
            ws.on('error', () => resolve('error'))
        })
        expect(await outcome(wsUrl)).not.toBe('open')
        expect(await outcome(wsUrl, { authorization: 'Bearer wrong' })).not.toBe('open')
        expect(await outcome(wsUrl, auth(), `http://localhost:5173`)).not.toBe('open')
        expect(await outcome(wsUrl, auth())).toBe('open')
        expect(await outcome(`${wsUrl}/?token=${token}`)).toBe('open')
    })

    it('never returns secrets from GET /api/config and keeps them on a round trip', async () => {
        const read = await send('GET', '/api/config', auth())
        expect(read.status).toBe(200)
        expect(read.body).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
        const redacted = JSON.parse(read.body).channels.telegram.token
        const write = await send('POST', '/api/config', auth(), { channels: { telegram: { enabled: true, token: redacted, allowFrom: ['111'] } } })
        expect(write.status).toBe(200)
        const { readFileSync } = await import('node:fs')
        const saved = JSON.parse(readFileSync(join(sandbox, 'xaventra.config.json'), 'utf-8'))
        expect(saved.channels.telegram.token).toBe('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    })

    it('refuses to clear or blank the owner allow-list', async () => {
        for (const allowFrom of [[], [''], ['  '], 'x'])
            expect((await send('POST', '/api/config', auth(), { channels: { telegram: { allowFrom } } })).status, JSON.stringify(allowFrom)).toBe(400)
    })

    it('builds the node update only from the configured URL, never from Host', async () => {
        const unconfigured = await send('POST', '/api/mesh/update-node', auth(), { targetNode: 'node-a' })
        expect(unconfigured.status).toBe(503)
        expect(delegateTask).not.toHaveBeenCalled()

        process.env.NOVA_MESH_BUNDLE_URL = 'http://100.64.0.10:3011/api/mesh/bundle'
        const configured = await send('POST', '/api/mesh/update-node', auth(), { targetNode: 'node-a' })
        expect(configured.status).toBe(200)
        expect(delegateTask).toHaveBeenCalledTimes(1)
        const command = String((delegateTask.mock.calls[0] as unknown[])[1])
        expect(command).toContain("'http://100.64.0.10:3011/api/mesh/bundle'")
        expect(command).not.toContain('127.0.0.1')
    })

    it('does not read session files outside .nova-sessions (N-4)', async () => {
        const traversal = await send('GET', '/api/sessions/..%2F.nova-data%2Foutside', auth())
        expect(traversal.body).not.toContain('outside-secret')
        expect(traversal.status).toBe(400)
        expect((await send('POST', '/api/sessions/..%2F.nova-data%2Foutside/resume', auth())).status).toBe(400)
    })
})
