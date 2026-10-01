import { describe, expect, it } from 'vitest'
import { ipToInt, ownSubnets, scanHosts, scanTargetAllowed } from './net-scope.js'
import { ProbeLimiter, discoverDevices, identifyHttp } from './discovery.js'

const lan = { eth0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }

describe('Selbst-Erkennung: Scan bleibt in eigenen privaten Netzen', () => {
    it('nimmt nur private/Tailnet-Interfaces, begrenzt breite Netze auf /24', () => {
        const scope = ownSubnets({
            eth0: [{ address: '10.4.7.9', netmask: '255.0.0.0', family: 'IPv4', internal: false }],
            wan: [{ address: '8.8.4.4', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
            lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
            ts0: [{ address: '100.86.70.71', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
            ll: [{ address: '169.254.3.4', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
        })
        expect(scope.subnets).toHaveLength(1)
        expect(scope.subnets[0].bits).toBe(24)
        expect(scope.hasTailnet).toBe(true)
        const plan = scanHosts(scope, [], 1024)
        expect(plan.hosts.length).toBe(254)
        expect(plan.hosts.every(host => host.startsWith('10.4.7.'))).toBe(true)
    })

    it('lehnt öffentliche, Sonder- und fremde private Netze ab', () => {
        const scope = ownSubnets(lan)
        for (const ip of ['8.8.8.8', '1.2.3.4', '127.0.0.1', '169.254.169.254', '224.0.0.251', '0.0.0.0', '192.168.2.5', '10.0.0.1', '172.16.0.1', '192.168.1.0', '192.168.1.255', '::1', 'drucker.local', '0300.0250.1.5']) {
            expect(scanTargetAllowed(ip, scope).allowed, ip).toBe(false)
        }
        expect(scanTargetAllowed('192.168.1.77', scope).allowed).toBe(true)
        // Tailnet only with an own tailnet interface.
        expect(scanTargetAllowed('100.101.1.2', scope).allowed).toBe(false)
        expect(scanTargetAllowed('100.101.1.2', ownSubnets({ ...lan, ts: [{ address: '100.64.0.5', netmask: '255.255.255.255', family: 'IPv4', internal: false }] })).allowed).toBe(true)
    })

    it('öffentliche Adressen bleiben gesperrt, selbst wenn ein Scope sie fälschlich enthielte', () => {
        const broken = { subnets: [{ base: ipToInt('8.8.8.0'), bits: 24 }, { base: ipToInt('169.254.169.0'), bits: 24 }], hasTailnet: false }
        expect(scanTargetAllowed('8.8.8.8', broken).allowed).toBe(false)
        expect(scanTargetAllowed('169.254.169.254', broken).allowed).toBe(false)
    })

    it('nimmt konfigurierte Zusatz-Hosts nur, wenn sie im eigenen Netz liegen', () => {
        const plan = scanHosts(ownSubnets(lan), ['1.1.1.1', '192.168.50.3', '100.70.0.1', '192.168.1.9'], 10)
        expect(plan.hosts[0]).toBe('192.168.1.9')
        expect(plan.rejected.map(item => item.host).sort()).toEqual(['1.1.1.1', '100.70.0.1', '192.168.50.3'])
        expect(plan.hosts).toHaveLength(10)
        expect(plan.truncated).toBe(true)
    })

    it('ohne private Interfaces wird gar nichts geprobt (fremdes Netz)', async () => {
        const probed: string[] = []
        const report = await discoverDevices({ deadlineMs: 1000, ratePerSec: 200, concurrency: 4, maxHosts: 512, mdns: false, tailnetHosts: ['8.8.8.8'] }, {
            interfaces: { wan: [{ address: '203.0.113.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }] },
            tcpProbe: async host => { probed.push(host); return false },
            httpProbe: async () => null,
        })
        expect(probed).toEqual([])
        expect(report.scannedHosts).toBe(0)
        expect(report.rejected.map(item => item.host)).toEqual(['8.8.8.8'])
    })

    it('mDNS-Antworten mit fremden Adressen werden verworfen', async () => {
        const report = await discoverDevices({ deadlineMs: 500, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: true, tailnetHosts: [] }, {
            interfaces: lan,
            tcpProbe: async () => false, httpProbe: async () => null,
            mdnsBrowse: async () => [{ type: 'moonraker', host: '93.184.216.34', port: 7125 }, { type: 'moonraker', host: '192.168.1.40', port: 7125, name: 'voron' }],
        })
        expect(report.candidates.map(item => item.host)).toEqual(['192.168.1.40'])
        expect(report.rejected.some(item => item.host === '93.184.216.34')).toBe(true)
    })
})

describe('Selbst-Erkennung: Rate- und Zeitlimit', () => {
    it('hält Verbindungen/s und Parallelität ein', async () => {
        const starts: number[] = []
        let inFlight = 0
        let maxInFlight = 0
        const report = await discoverDevices({ deadlineMs: 5000, ratePerSec: 50, concurrency: 3, maxHosts: 6, mdns: false, tailnetHosts: [] }, {
            interfaces: lan,
            tcpProbe: async () => {
                starts.push(Date.now()); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
                await new Promise(resolve => setTimeout(resolve, 15)); inFlight--; return false
            },
            httpProbe: async () => null,
        })
        expect(report.probes).toBe(30) // 6 Hosts × 5 Ports
        expect(maxInFlight).toBeLessThanOrEqual(3)
        const sorted = [...starts].sort((a, b) => a - b)
        // 30 starts at 50/s need at least ~29 × 20 ms.
        expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual(29 * 20 - 40)
    })

    it('bricht nach der Gesamtzeit ab und meldet das', async () => {
        const started = Date.now()
        let probes = 0
        const report = await discoverDevices({ deadlineMs: 300, ratePerSec: 200, concurrency: 4, maxHosts: 254, mdns: false, tailnetHosts: [] }, {
            interfaces: lan,
            tcpProbe: async () => { probes++; await new Promise(resolve => setTimeout(resolve, 40)); return false },
            httpProbe: async () => null,
        })
        expect(Date.now() - started).toBeLessThan(1500)
        expect(report.timedOut).toBe(true)
        expect(report.truncated).toBe(true)
        expect(probes).toBeLessThan(254 * 5)
        expect(probes).toBeLessThanOrEqual(Math.ceil(0.3 * 200) + 4)
    })

    it('Limiter startet nach Ablauf nichts mehr', async () => {
        let clock = 0
        const limiter = new ProbeLimiter(10, 2, 250, () => clock, async ms => { clock += ms })
        const ran: number[] = []
        for (let i = 0; i < 10; i++) await limiter.run(async () => { ran.push(clock) })
        expect(ran).toEqual([0, 100, 200])
    })

    it('erkennt Geräte nur an unauthentifizierten Kennungen', () => {
        expect(identifyHttp(7125, '/server/info', { status: 200, body: '{"result":{"klippy_state":"ready"}}' })).toBe('moonraker')
        expect(identifyHttp(8123, '/manifest.json', { status: 200, body: '{"name": "Home Assistant"}' })).toBe('homeassistant')
        expect(identifyHttp(80, '/', { status: 200, body: '<title>OctoPrint</title>' })).toBe('octoprint')
        expect(identifyHttp(80, '/', { status: 200, body: '<title>Router</title>' })).toBeNull()
        expect(identifyHttp(7125, '/server/info', { status: 401, body: 'moonraker' })).toBeNull()
    })
})
