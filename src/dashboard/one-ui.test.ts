import { request } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// One UI: the dashboard server delivers exactly the Desktop renderer files over
// HTTP; all data comes from the token-protected Desktop API. Regressions for
// C-1/H-1/H-2 on the new delivery path, plus: no secrets in the delivered
// files, no token cookie, owner data only with the Desktop owner token, and
// the removed legacy endpoints really answer nothing.

const DESKTOP_TOKEN = ['one-ui-desktop-', 'owner-token-1357911'].join('')

describe('dashboard server delivers the one shared UI', () => {
    let port = ''
    let gatewayToken = ''
    let stop: () => Promise<void> = async () => undefined
    const sandbox = join(process.cwd(), '.nova-test-tmp', `one-ui-${randomUUID()}`)

    beforeAll(async () => {
        mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
        vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
        const server = await import('./server.js')
        const url = await server.startDashboard(0, '127.0.0.1')
        port = new URL(url).port
        stop = server.stopDashboard
        gatewayToken = (await import('../infra/gateway-auth.js')).getGatewayAuth().token || ''
    }, 60_000)
    afterAll(async () => { await stop(); vi.restoreAllMocks() })
    afterEach(() => { vi.unstubAllEnvs() })

    type Reply = { status: number; body: string; headers: Record<string, any> }
    const send = (method: string, path: string, headers: Record<string, string> = {}) => new Promise<Reply>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }))
        })
        req.on('error', reject)
        req.end()
    })

    it('has a real gateway token to test against', () => {
        expect(gatewayToken.length).toBeGreaterThanOrEqual(32)
    })

    it('serves the four UI files without data, token or cookie, with a strict CSP', async () => {
        const page = await send('GET', '/')
        expect(page.status).toBe(200)
        expect(page.headers['content-type']).toMatch(/text\/html/)
        expect(page.headers['content-security-policy']).toContain("script-src 'self'")
        expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
        expect(page.headers['set-cookie']).toBeUndefined()
        expect(page.body).toContain('bridge.js')
        // 2.85 Paket D: the Werkzeugkasten page is its own renderer file.
        expect(page.body).toContain('werkzeugkasten.js')
        for (const name of ['bridge.js', 'app.js', 'styles.css', 'werkzeugkasten.js']) {
            const file = await send('GET', `/${name}`)
            expect(file.status, name).toBe(200)
            expect(file.headers['cache-control']).toBe('no-store')
            expect(file.body).not.toContain(gatewayToken)
            expect(file.body).not.toContain(DESKTOP_TOKEN)
        }
    })

    it('never keeps a token in the address bar and never sets a cookie', async () => {
        const old = await send('GET', `/?token=${gatewayToken}`)
        expect(old.status).toBe(303)
        expect(old.headers.location).toBe('/')
        expect(old.headers['set-cookie']).toBeUndefined()
    })

    it('serves nothing beyond the UI files', async () => {
        for (const path of ['/.nova-gateway-token', '/server.js', '/public/app.js', '/style.css', '/%2e%2e/package.json', '/main.cjs'])
            expect((await send('GET', path)).status, path).toBe(404)
    })

    it('refuses the API without a token and has no legacy dashboard endpoints left', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        expect((await send('GET', '/api/desktop/bootstrap')).status).toBe(401)
        expect((await send('GET', '/api/desktop/heute', { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong-wrong' })).status).toBe(401)
        const auth = { authorization: `Bearer ${gatewayToken}` }
        for (const path of ['/api/status', '/api/config', '/api/logs', '/api/memory/search?q=x', '/api/mesh/bundle', '/api/sessions'])
            expect((await send('GET', path, auth)).status, path).toBe(404)
    })

    it('refuses a DNS-rebound Host and a foreign Origin before anything else', async () => {
        expect((await send('GET', '/', { host: `rebound.evil.example:${port}` })).status).toBe(403)
        expect((await send('GET', '/api/desktop/heute', { host: `rebound.evil.example:${port}`, authorization: `Bearer ${gatewayToken}` })).status).toBe(403)
        expect((await send('GET', '/app.js', { origin: 'http://localhost:5173' })).status).toBe(403)
    })

    it('owner views need the Desktop owner token; the gateway token is not the owner', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        expect((await send('GET', '/api/desktop/heute', { authorization: `Bearer ${gatewayToken}` })).status).toBe(403)
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', DESKTOP_TOKEN)
        expect((await send('GET', '/api/desktop/heute')).status).toBe(401)
        expect((await send('GET', '/api/desktop/heute', { authorization: `Bearer ${gatewayToken}` })).status).toBe(401)
        const owner = await send('GET', '/api/desktop/gedaechtnis', { authorization: `Bearer ${DESKTOP_TOKEN}` })
        expect(owner.status).toBe(200)
        expect(owner.body).not.toContain(DESKTOP_TOKEN)
        expect(owner.body).not.toContain(gatewayToken)
    })
})
