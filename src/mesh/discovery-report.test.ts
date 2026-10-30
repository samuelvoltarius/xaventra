import { describe, expect, it } from 'vitest'
import { acceptedScoutCandidates, validDiscoveryReport } from './discovery-report.js'

// Späher (30.10.2026): a scout node (NAS in the home LAN) reports what it found in its own
// networks. Main accepts only well-formed reports and keeps the one gate rule (net-scope):
// private or own tailnet, never public, and only inside a reported private subnet (≤ /24).
const report = (extra: Record<string, unknown> = {}) => ({
    subnets: ['192.168.1.0/24'], hasTailnet: false,
    candidates: [
        { type: 'homeassistant', host: '192.168.1.20', port: 8123, via: 'http', name: 'Home Assistant' },
        { type: 'networkdevice', host: '192.168.1.1', port: 80, via: 'tcp' },
    ],
    ...extra,
})

describe('discovery report from a scout node', () => {
    it('accepts a bounded report of its own private subnet', () => {
        expect(validDiscoveryReport(report())).toBe(true)
        expect(acceptedScoutCandidates(report() as any)).toMatchObject({ accepted: [{ host: '192.168.1.20' }, { host: '192.168.1.1' }], rejected: 0 })
    })
    it.each([
        ['public subnet', { subnets: ['8.8.8.0/24'] }],
        ['subnet wider than /24', { subnets: ['192.168.0.0/16'] }],
        ['malformed subnet', { subnets: ['192.168.1.0'] }],
        ['too many subnets', { subnets: Array.from({ length: 9 }, (_, i) => `10.0.${i}.0/24`) }],
        ['extra field', { command: 'rm -rf /' }],
        ['bad candidate host', { candidates: [{ type: 'homeassistant', host: 'ha.local', port: 8123, via: 'http' }] }],
        ['bad port', { candidates: [{ type: 'homeassistant', host: '192.168.1.20', port: 70000, via: 'http' }] }],
        ['bad via', { candidates: [{ type: 'homeassistant', host: '192.168.1.20', port: 8123, via: 'ssh' }] }],
        ['too many candidates', { candidates: Array.from({ length: 513 }, (_, i) => ({ type: 'networkdevice', host: `192.168.1.${i % 250 + 1}`, port: 80, via: 'tcp' })) }],
    ])('rejects a report with %s', (_label, extra) => expect(validDiscoveryReport(report(extra))).toBe(false))
    it('Gegenprobe: public and foreign addresses inside a valid report are never accepted', () => {
        const mixed = report({ candidates: [
            { type: 'networkdevice', host: '192.168.1.5', port: 80, via: 'tcp' },
            { type: 'networkdevice', host: '8.8.8.8', port: 443, via: 'tcp' },
            { type: 'networkdevice', host: '192.168.2.5', port: 80, via: 'tcp' },
            { type: 'networkdevice', host: '100.64.0.9', port: 80, via: 'tcp' },
        ] })
        expect(validDiscoveryReport(mixed)).toBe(true)
        const result = acceptedScoutCandidates(mixed as any)
        expect(result.accepted.map(c => c.host)).toEqual(['192.168.1.5'])
        expect(result.rejected).toBe(3)
    })
    it('tailnet addresses only when the scout has an own tailnet interface', () => {
        const withTailnet = report({ hasTailnet: true, candidates: [{ type: 'networkdevice', host: '100.64.12.34', port: 443, via: 'tcp' }] })
        expect(acceptedScoutCandidates(withTailnet as any).accepted).toHaveLength(1)
    })
})
