import { it, expect } from 'vitest'
import { matterTargetAllowed, parseMatterRoutes, matterMulticastAllowed } from './matter-scope.js'
import { mdnsCandidates, discoverDevices, parseMdnsResponse } from './discovery.js'
const interfaces = { eth0: [
    { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    { address: 'fd66:3c82:fb24:a8e8::1', netmask: 'ffff:ffff:ffff:ffff::', cidr: 'fd66:3c82:fb24:a8e8::1/64', family: 'IPv6', internal: false },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
] }
it('permits only own IPv6 ULA prefix or explicitly scoped link-local peers, no broad private shortcut', () => {
    expect(matterTargetAllowed('fd66:3c82:fb24:a8e8::abcd', interfaces)).toBe(true)
    expect(matterTargetAllowed('fe80::abcd%eth0', interfaces)).toBe(true)
    for (const host of ['fd66:3c82:fb24:ffff::abcd', 'fd00::123', 'fe80::abcd', 'fe80::abcd%other', '::1', '::ffff:192.168.1.21', '2606:4700:4700::1111', 'ff02::fb', 'fd66:3c82:fb24:a8e8::1', 'fd66:3c82:fb24:a8e8::abcd%other']) expect(matterTargetAllowed(host, interfaces)).toBe(false)
})
it('projects Matter AAAA and meshcop announcements as observations, not proven hardware or control', async () => {
    const records: any[] = [
        { name: '_matter._tcp.local', type: 12, data: { ptr: 'fabric-node._matter._tcp.local' } },
        { name: 'fabric-node._matter._tcp.local', type: 33, data: { target: 'device.local', port: 5540 } },
        { name: 'device.local', type: 28, data: { aaaa: 'fd66:3c82:fb24:a8e8::abcd' } },
        { name: '_meshcop._udp.local', type: 12, data: { ptr: 'router._meshcop._udp.local' } },
        { name: 'router._meshcop._udp.local', type: 33, data: { target: 'router.local', port: 49191 } },
        { name: 'router.local', type: 1, data: { a: '192.168.1.25' } },
    ]
    const observed = mdnsCandidates(records)
    const result = await discoverDevices({ mdns: true, maxHosts: 1, deadlineMs: 1000, ratePerSec: 200, concurrency: 2, tailnetHosts: [] }, { interfaces, mdnsBrowse: async () => observed, neighbors: async () => [], tcpProbe: async () => false, httpProbe: async () => null })
    expect(result.candidates.find(d => d.port === 5540)).toMatchObject({ host: 'fd66:3c82:fb24:a8e8::abcd', evidence: { service: '_matter._tcp.local' } })
    expect(result.candidates.find(d => d.port === 49191)?.hardware?.certainty).not.toBe('confirmed')
})
it('parses bounded wire AAAA records', () => {
    const name = Buffer.from([6, ...Buffer.from('device'), 5, ...Buffer.from('local'), 0])
    const header = Buffer.alloc(12); header.writeUInt16BE(1, 6)
    const rr = Buffer.alloc(10); rr.writeUInt16BE(28); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(16, 8)
    const address = Buffer.from('fd663c82fb24a8e8000000000000abcd', 'hex')
    expect(parseMdnsResponse(Buffer.concat([header, name, rr, address]))[0].data.aaaa).toBe('fd66:3c82:fb24:a8e8:0:0:0:abcd')
})
it('accepts routed Thread /64 only through an own LAN link-local gateway, never default, broad, public or tailnet routes', () => {
    const routes = parseMatterRoutes('fd07:9ca5:54a1:1::/64 via fe80::abcd dev eth0 proto ra\nfd00::/8 via fe80::abcd dev eth0\n2600::/64 via fe80::abcd dev eth0\nfd11::/64 via fe80::abcd dev tailscale0\ndefault via fe80::abcd dev eth0', interfaces)
    expect(routes).toEqual([{ prefix: 'fd07:9ca5:54a1:1::', bits: 64, interface: 'eth0' }])
    expect(matterTargetAllowed('fd07:9ca5:54a1:1::2', interfaces, routes)).toBe(true)
    expect(matterTargetAllowed('fd07:9ca5:54a1:2::2', interfaces, routes)).toBe(false)
    expect(matterMulticastAllowed('ff02::fb%eth0', 5353, interfaces)).toBe(true)
    expect(matterMulticastAllowed('ff02::fb%tailscale0', 5353, interfaces)).toBe(false)
})
