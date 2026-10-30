import { describe, expect, it } from 'vitest'
import { intToIp, ownSubnets, restrictScope, type InterfaceMap } from './net-scope.js'

// 2.91.2 (NAS scout live, 37 finds): Synology names its Docker bridges `docker-<hex>`; ownSubnets skipped only
// docker<N>, so 172.20.0.0/24 was scanned as LAN. And autonomy.sensing.discovery.subnets narrows the scope to an
// allowlist inside the own networks - never widening it.
const ip = (address: string, netmask = '255.255.255.0') => [{ address, netmask, family: 'IPv4', internal: false }]
const SYNOLOGY: InterfaceMap = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    eth0: ip('192.168.0.20'),
    'docker-496566d4': ip('172.20.0.1'),
    'docker-adca2ccf': ip('172.21.0.1'),
    'docker-b492ed46': ip('172.22.0.1'),
    docker0: ip('172.17.0.1', '255.255.0.0'),
    tailscale0: ip('100.64.10.7', '255.192.0.0'),
}
const cidrs = (scope: { subnets: Array<{ base: number; bits: number }> }) => scope.subnets.map(item => `${intToIp(item.base)}/${item.bits}`)

describe('own scan scope on a Synology NAS', () => {
    it('skips Synology docker-<hex> bridges like docker0', () => {
        const scope = ownSubnets(SYNOLOGY)
        expect(cidrs(scope)).toEqual(['192.168.0.0/24'])
        expect(scope.hasTailnet).toBe(true)
    })
})

describe('discovery.subnets allowlist', () => {
    const scope = ownSubnets({ eth0: ip('192.168.0.20'), eth1: ip('10.1.2.3'), tailscale0: ip('100.64.10.7', '255.192.0.0') })
    it('keeps only own subnets inside the allowlist and drops the tailnet unless listed', () => {
        const restricted = restrictScope(scope, ['192.168.0.0/24'])
        expect(cidrs(restricted)).toEqual(['192.168.0.0/24'])
        expect(restricted.hasTailnet).toBe(false)
        expect(restricted.ignored).toEqual([])
    })
    it('a narrower allow entry narrows the own subnet', () => {
        expect(cidrs(restrictScope(scope, ['192.168.0.64/26']))).toEqual(['192.168.0.64/26'])
    })
    it('counter-test: foreign or public entries are ignored with a reason, never widening the scope', () => {
        const restricted = restrictScope(scope, ['8.8.8.0/24', '192.168.5.0/24', 'kaputt'])
        expect(cidrs(restricted)).toEqual([])
        expect(restricted.ignored.map(item => item.entry)).toEqual(['8.8.8.0/24', '192.168.5.0/24', 'kaputt'])
    })
    it('no allowlist leaves the scope as it is', () => {
        expect(cidrs(restrictScope(scope, []))).toEqual(cidrs(scope))
        expect(restrictScope(scope, []).hasTailnet).toBe(true)
    })
})
