import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Server } from 'node:http'
import { startRestApi } from './rest-api.js'
let server: Server | undefined
afterEach(async () => { vi.unstubAllEnvs(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined } })
async function start(handler = vi.fn(async (_channel, _user, _content, reply) => { await reply('verified response') })) {
    server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, handler, () => ({ version: 'test' }))
    return { url: `http://127.0.0.1:${(server.address() as any).port}`, handler }
}
describe('real REST listener', () => {
    it('starts, requires authentication, forwards a message and returns the actual reply', async () => {
        vi.stubEnv('NOVA_API_TOKEN', 'synthetic-api-test')
        const { url, handler } = await start()
        expect((await fetch(`${url}/v1/health`)).status).toBe(200)
        expect((await fetch(`${url}/v1/status`)).status).toBe(401)
        const response = await fetch(`${url}/v1/message`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-api-test' }, body: JSON.stringify({ content: 'hello' }) })
        expect(await response.json()).toEqual({ ok: true, response: 'verified response' })
        expect(handler).toHaveBeenCalledWith('rest-api', 'api-user', 'hello', expect.any(Function))
    })
    it('rejects malformed requests without an uncaught async exception or pipeline call', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        const { url, handler } = await start()
        for (const payload of [null, { content: 42 }, { content: 'hello', from: {} }]) {
            const response = await fetch(`${url}/v1/message`, { method: 'POST', body: JSON.stringify(payload) })
            expect(response.status).toBe(400)
        }
        expect(handler).not.toHaveBeenCalled()
        expect((await fetch(`${url}/v1/health`)).status).toBe(200)
    })
    it('refuses unauthenticated remote exposure before binding a port', async () => {
        vi.stubEnv('NOVA_API_TOKEN', '')
        await expect(startRestApi({ enabled: true, port: 0, host: '0.0.0.0' }, vi.fn(), () => ({}))).rejects.toThrow('required')
    })
})
