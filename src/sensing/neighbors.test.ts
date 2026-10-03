import { describe, expect, it } from 'vitest'
import { parseNeighbors } from './neighbors.js'
import { discoverDevices, DISCOVERY_PORTS } from './discovery.js'

describe('bounded broader LAN discovery', () => {
    it('parses Linux, Windows and macOS caches without treating incomplete rows as devices', () => {
        expect(parseNeighbors(JSON.stringify([{ dst: '192.168.1.7', lladdr: 'aa:bb:cc:dd:ee:01', state: ['STALE'] }, { dst: '192.168.1.8', lladdr: 'aa:bb:cc:dd:ee:02', state: ['FAILED'] }]))).toEqual(['192.168.1.7'])
        expect(parseNeighbors('192.168.1.7 aa-bb-cc-dd-ee-01 dynamic\n192.168.1.255 ff-ff-ff-ff-ff-ff static')).toEqual(['192.168.1.7'])
        expect(parseNeighbors('? (192.168.1.7) at aa:bb:cc:dd:ee:01 on en0\n? (192.168.1.8) at (incomplete)')).toEqual(['192.168.1.7'])
        expect(parseNeighbors('x'.repeat(256 * 1024 + 1))).toEqual([])
    })
    it('records only own-scoped neighbor observations, without a control or online claim', async () => {
        const report = await discoverDevices({ deadlineMs: 1000, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: false, tailnetHosts: [] }, {
            interfaces: { eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] },
            neighbors: async () => ['192.168.1.7', '192.168.2.7', '8.8.8.8'], tcpProbe: async () => false, httpProbe: async () => null,
        })
        expect(report.candidates).toHaveLength(1)
        expect(report.candidates[0]).toMatchObject({ type: 'networkdevice', host: '192.168.1.7', port: 0, via: 'neighbor' })
        expect(JSON.stringify(report.candidates[0].evidence)).toContain('kein Online- oder Steuerungsbeleg')
        expect(DISCOVERY_PORTS).toEqual(expect.arrayContaining([22, 443, 445, 3389, 631, 9100, 554]))
    })
})
