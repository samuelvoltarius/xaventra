import express from 'express'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopApi } from './desktop-api.js'

vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))

// MI-12 / TOK-1: the owner is authenticated by NOVA_DESKTOP_API_TOKEN only.
// Tokenless loopback access is a non-owner mode for direct local clients:
// no owner claim via x-nova-principal, no DNS rebinding, no proxy, no cross-site.

const TOKEN = ['desktop-auth-', 'test-token-987654'].join('')
afterEach(() => vi.unstubAllEnvs())

async function withServer(run: (port: number) => Promise<void>) {
    const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run((server.address() as AddressInfo).port) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

/** Raw request so Host/Origin headers can be set like a rebinding page or a proxy would. */
function call(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => { res.resume(); resolve(res.statusCode || 0) })
        req.once('error', reject); req.end()
    })
}

describe('Desktop API owner authentication', () => {
    it('TOK-1: without a token nobody becomes owner by sending the owner principal', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', ''); vi.stubEnv('NOVA_DESKTOP_OWNER_ID', 'owner')
        await withServer(async port => {
            expect(await call(port, '/api/desktop/trust/repairs', { host: `127.0.0.1:${port}`, 'x-nova-principal': 'owner' })).toBe(403)
            expect(await call(port, '/api/desktop/trust/repairs', { host: `127.0.0.1:${port}`, 'x-nova-principal': 'someone' })).toBe(403)
        })
    })

    it('TOK-1: with a token, the token (not the header) makes the owner', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', TOKEN); vi.stubEnv('NOVA_DESKTOP_OWNER_ID', 'owner')
        await withServer(async port => {
            expect(await call(port, '/api/desktop/trust/repairs', { host: `127.0.0.1:${port}`, 'x-nova-principal': 'owner' })).toBe(401)
            expect(await call(port, '/api/desktop/trust/repairs', { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'x-nova-principal': 'not-the-owner' })).toBe(200)
        })
    })

    it('MI-12: tokenless loopback refuses DNS rebinding, proxies and cross-site browsers', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        await withServer(async port => {
            const ok = { host: `127.0.0.1:${port}`, 'x-nova-principal': 'local-user' }
            expect(await call(port, '/api/desktop/trust/runs', ok)).toBe(200)
            expect(await call(port, '/api/desktop/trust/runs', { ...ok, host: `rebind.attacker.example:${port}` })).toBe(401)
            expect(await call(port, '/api/desktop/trust/runs', { ...ok, 'x-forwarded-for': '203.0.113.5' })).toBe(401)
            expect(await call(port, '/api/desktop/trust/runs', { ...ok, origin: 'https://evil.example' })).toBe(401)
            expect(await call(port, '/api/desktop/trust/runs', { ...ok, 'sec-fetch-site': 'cross-site' })).toBe(401)
        })
    })
})
