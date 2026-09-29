import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isGatewayRequestAuthorized } from './gateway.js'

const TOKEN = 'a'.repeat(64)
const req = (headers: Record<string, string> = {}, url = '/api/nova/stop') => ({ headers, url }) as any

describe('gateway access guard', () => {
    it('accepts only the exact gateway token', () => {
        expect(isGatewayRequestAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true)
        expect(isGatewayRequestAuthorized(req({}, `/?token=${TOKEN}`), TOKEN)).toBe(true)
        expect(isGatewayRequestAuthorized(req(), TOKEN)).toBe(false)
        expect(isGatewayRequestAuthorized(req({ authorization: `Bearer ${'b'.repeat(64)}` }), TOKEN)).toBe(false)
        expect(isGatewayRequestAuthorized(req({ authorization: `Bearer ${TOKEN.slice(1)}` }), TOKEN)).toBe(false)
        expect(isGatewayRequestAuthorized(req({ authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(false)
    })

    it('fails closed without a configured token', () => {
        expect(isGatewayRequestAuthorized(req({ authorization: 'Bearer ' }), '')).toBe(false)
    })

    it('binds to loopback, has no wildcard CORS and guards the WebSocket', () => {
        const source = readFileSync(new URL('./gateway.ts', import.meta.url), 'utf8')
        expect(source).not.toContain("'Access-Control-Allow-Origin', '*'")
        expect(source).toContain("httpServer.listen(port, '127.0.0.1'")
        expect(source).toMatch(/new WebSocketServer\(\{ server: httpServer, verifyClient: info => isGatewayRequestAuthorized\(info\.req\) \}\)/)
    })
})
