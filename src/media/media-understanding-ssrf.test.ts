import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchUrlContent } from './media-understanding.js'

// MI-4: fetch_url (media) must go through the SSRF guard. Loopback, LAN and
// Tailscale targets are refused before any request is sent.

let server: Server
let hits = 0
let port = 0

beforeAll(async () => {
    server = createServer((_req, res) => { hits++; res.setHeader('content-type', 'text/plain'); res.end('INTERNAL-SECRET-TOKEN') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

describe('MI-4 media fetch_url SSRF', () => {
    it('refuses a loopback URL without contacting it', async () => {
        const result = await fetchUrlContent(`http://127.0.0.1:${port}/api/state`)
        expect(result.text).not.toContain('INTERNAL-SECRET-TOKEN')
        expect(result.error).toMatch(/SSRF/)
        expect(hits).toBe(0)
    })

    it.each(['http://localhost:18789/', 'http://[::1]:18789/', 'http://2130706433:18789/', 'file:///etc/passwd'])(
        'refuses %s',
        async url => {
            const result = await fetchUrlContent(url)
            expect(result.error).toMatch(/SSRF/)
            expect(result.text).toBe('')
        },
    )
})
