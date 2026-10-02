import { describe, expect, it } from 'vitest'
import { dashboardTokenFromHeaders, isAllowedDashboardHost, isLoopbackAddress, isLoopbackHostHeader, isSameOriginRequest, isValidDashboardToken } from './access-guard.js'

// INT-10 / C-1 / H-1 regressions for the browser path of the one UI and the
// Desktop-Direkt gateway: loopback peers, DNS rebinding, foreign origins and
// the constant-time token comparison.

describe('dashboard access guard', () => {
    it('recognises loopback peers only', () => {
        for (const ip of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(ip), ip).toBe(true)
        for (const ip of ['100.86.70.71', '192.168.0.2', '::ffff:10.0.0.1', '', undefined, '1127.0.0.1']) expect(isLoopbackAddress(ip as any), String(ip)).toBe(false)
    })

    it('accepts only loopback Host headers (DNS rebinding)', () => {
        for (const host of ['localhost:3011', '127.0.0.1:3011', '[::1]:3011', 'LOCALHOST', '127.0.0.1']) expect(isLoopbackHostHeader(host), host).toBe(true)
        for (const host of ['evil.example:3011', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined]) expect(isLoopbackHostHeader(host as any), String(host)).toBe(false)
    })

    it('allows loopback or the configured bind host only', () => {
        expect(isAllowedDashboardHost('127.0.0.1:3011')).toBe(true)
        expect(isAllowedDashboardHost('rebound.evil.example:3011')).toBe(false)
        expect(isAllowedDashboardHost('100.64.0.10:3011')).toBe(false)
        expect(isAllowedDashboardHost('100.64.0.10:3011', ['100.64.0.10'])).toBe(true)
    })

    it('treats another local port as a foreign origin', () => {
        expect(isSameOriginRequest('localhost:3011', 'http://localhost:3011')).toBe(true)
        expect(isSameOriginRequest('localhost:3011', undefined)).toBe(true)
        expect(isSameOriginRequest('localhost:3011', 'http://localhost:5173')).toBe(false)
        expect(isSameOriginRequest('127.0.0.1:3011', 'null')).toBe(false)
    })

    it('reads the token from bearer or header, never from a cookie', () => {
        expect(dashboardTokenFromHeaders({ authorization: 'Bearer abc' })).toBe('abc')
        expect(dashboardTokenFromHeaders({ 'x-nova-dashboard-token': 'def' })).toBe('def')
        expect(dashboardTokenFromHeaders({ cookie: 'nova_dashboard_token=ghi' })).toBe('')
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
})
