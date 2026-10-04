import { describe, expect, it, vi } from 'vitest'
import { parseSsdpDescription } from './ssdp.js'
import { discoverDevices, mdnsCandidates } from './discovery.js'
import { ownSubnets, scanTargetAllowed } from './net-scope.js'
const interfaces = { eth0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const packet = (location = 'http://192.168.1.2:8080/device.xml') => `HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\nUSN: uuid:lamp-1234::urn:schemas-upnp-org:device:BinaryLight:1\r\n\r\n`
describe('bounded device identity discovery', () => {
    it('accepts a private responder XML description, never arbitrary/different hosts or control endpoints', () => {
        expect(parseSsdpDescription(packet(), '192.168.1.2', interfaces)?.port).toBe(8080)
        for (const url of ['http://8.8.8.8/device.xml', 'http://192.168.1.3/device.xml', 'http://local/device.xml', 'http://192.168.1.2/reboot', 'http://user:password@192.168.1.2/device.xml', 'http://192.168.1.2/device.xml?token=x']) {
            expect(parseSsdpDescription(packet(url), '192.168.1.2', interfaces)).toBeNull()
        }
        expect(parseSsdpDescription(packet(), '192.168.2.2', interfaces)).toBeNull()
    })
    it('excludes named container bridges but preserves real 172.* LANs', () => {
        const address = (ip: string) => [{ address: ip, netmask: '255.255.255.0', family: 'IPv4', internal: false }]
        const scope = ownSubnets({ eth0: address('172.17.1.20'), docker0: address('172.18.0.1'), 'br-aabbccddeeff': address('172.19.0.1') })
        expect(scanTargetAllowed('172.17.1.2', scope).allowed).toBe(true)
        expect(scanTargetAllowed('172.18.0.2', scope).allowed).toBe(false)
        expect(scanTargetAllowed('172.19.0.2', scope).allowed).toBe(false)
    })
    it('verifies the light type and matching UDN, not just an SSDP advertisement', async () => {
        const xml = '<root><device><UDN>uuid:lamp-1234</UDN><modelName>Example Lamp</modelName><manufacturer>Example</manufacturer><deviceType>urn:schemas-upnp-org:device:BinaryLight:1</deviceType></device></root>'
        const request = vi.fn(async () => ({ status: 200, body: xml }))
        const deps = { interfaces, neighbors: async () => [], tcpProbe: async () => false, httpProbe: request, ssdpBrowse: async () => [parseSsdpDescription(packet(), '192.168.1.2', interfaces)!] }
        const result = await discoverDevices({ deadlineMs: 3000, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: true, tailnetHosts: [] }, deps)
        expect(result.candidates.find(c => c.hardware)?.hardware?.kind).toBe('light')
        expect(request.mock.calls[0][0]).toBe('http://192.168.1.2:8080/device.xml')
        const mismatch = await discoverDevices({ deadlineMs: 3000, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: true, tailnetHosts: [] }, { ...deps, httpProbe: async () => ({ status: 200, body: xml.replace('lamp-1234', 'other-device') }) })
        expect(mismatch.candidates.some(c => c.hardware)).toBe(false)
    })
    it('retains mDNS service and bounded model hints as evidence, not confirmed identity', () => {
        const result = mdnsCandidates([{ name: '_googlecast._tcp.local', type: 12, data: { ptr: 'Screen._googlecast._tcp.local' } },
            { name: 'Screen._googlecast._tcp.local', type: 33, data: { target: 'screen.local', port: 8009 } },
            { name: 'screen.local', type: 1, data: { a: '192.168.1.2' } },
            { name: 'Screen._googlecast._tcp.local', type: 16, data: { txt: { md: 'Example Display' } } }])
        expect(result[0].hints).toEqual({ service: '_googlecast._tcp.local', md: 'Example Display' })
        expect((result[0] as any).hardware).toBeUndefined()
    })
})
