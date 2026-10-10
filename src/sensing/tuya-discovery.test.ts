import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { parseTuyaAnnouncement, tuyaDiscoveryRequest, realTuyaBrowse } from './tuya-discovery.js'
import { discoverDevices } from './discovery.js'
import { recordCandidates } from './device-registry.js'
import { environmentAwareness } from './awareness.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const interfaces = { eth0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const key = createHash('md5').update('yGAdlopoPVldABfn').digest()
const observation = { ip: '192.168.1.21', gwId: 'device12345678901234', version: '3.3', productKey: 'product123', key: 'must-not-store-local-key', token: 'must-not-store-token', name: 'Lamp', dps: { '1': true } }
function legacy(v: unknown = observation, encrypted = false) {
    let payload = Buffer.from(JSON.stringify(v))
    if (encrypted) { const cipher = createCipheriv('aes-128-ecb', key, null); payload = Buffer.concat([cipher.update(payload), cipher.final()]) }
    const header = Buffer.alloc(20)
    header.writeUInt32BE(0x55aa); header.writeUInt32BE(0x13, 8); header.writeUInt32BE(payload.length + 12, 12)
    const body = Buffer.concat([header, payload]), footer = Buffer.alloc(8)
    footer.writeUInt32BE(crc32(body)); footer.writeUInt32BE(0xaa55, 4)
    return Buffer.concat([body, footer])
}
function modern(v: unknown = { ...observation, version: '3.5' }) {
    const payload = Buffer.from(JSON.stringify(v)), header = Buffer.alloc(18), iv = Buffer.alloc(12, 0x42)
    header.writeUInt32BE(0x6699); header.writeUInt32BE(0x23, 10); header.writeUInt32BE(12 + payload.length + 16, 14)
    const cipher = createCipheriv('aes-128-gcm', key, iv); cipher.setAAD(header.subarray(4))
    return Buffer.concat([header, iv, cipher.update(payload), cipher.final(), cipher.getAuthTag(), Buffer.from([0, 0, 0x99, 0x66])])
}

describe('Tuya discovery, not credentialed device control', () => {
    it('decodes checked 55AA plaintext and ECB announcements, without inventing lamp/plug or retaining secrets', () => {
        for (const packet of [legacy(), legacy(observation, true)]) {
            const result = parseTuyaAnnouncement(packet, observation.ip, interfaces)!
            expect(result.hardware).toMatchObject({ ecosystem: 'tuya', kind: 'unknown', certainty: 'confirmed', identity: observation.gwId })
            expect(result.hardware.connector).toBe('tuya-announcements')
            expect(result.evidence.produktkennung).toBe('product123')
            expect(JSON.stringify(result)).not.toMatch(/must-not-store|"dps"|"name":"Lamp"/)
        }
    })
    it('validates GCM, sender/IP binding, physical scope, version, bounded lengths and checksums', () => {
        const packet = modern()
        expect(parseTuyaAnnouncement(packet, observation.ip, interfaces)?.hardware.ecosystem).toBe('tuya')
        for (const bad of [Buffer.alloc(4097), packet.subarray(0, -1), legacy({ ...observation, version: '9.9' }), legacy({ ...observation, gwId: 'x' })])
            expect(parseTuyaAnnouncement(bad, observation.ip, interfaces)).toBeNull()
        const corrupt = Buffer.from(packet); corrupt[35] ^= 1
        expect(parseTuyaAnnouncement(corrupt, observation.ip, interfaces)).toBeNull()
        const badCrc = legacy(); badCrc[25] ^= 1
        expect(parseTuyaAnnouncement(badCrc, observation.ip, interfaces)).toBeNull()
        for (const sender of ['8.8.8.8', '192.168.1.22', '192.168.2.21', '100.64.0.10']) expect(parseTuyaAnnouncement(packet, sender, interfaces)).toBeNull()
        expect(parseTuyaAnnouncement(packet, observation.ip, { docker0: interfaces.eth0 })).toBeNull()
    })
    it('encodes only fixed device-info request, never a control/provisioning command', () => {
        const packet = tuyaDiscoveryRequest('192.168.1.20')
        expect(packet.readUInt32BE(10)).toBe(0x25)
        const cipher = createDecipheriv('aes-128-gcm', key, packet.subarray(18, 30))
        cipher.setAAD(packet.subarray(4, 18)); cipher.setAuthTag(packet.subarray(-20, -4))
        expect(JSON.parse(Buffer.concat([cipher.update(packet.subarray(30, -20)), cipher.final()]).toString())).toEqual({ from: 'app', ip: '192.168.1.20' })
        expect(() => tuyaDiscoveryRequest('8.8.8.8')).toThrow()
    })
    it('records bounded discovery observations but never connects to a Tuya control port', async () => {
        const tuya = parseTuyaAnnouncement(legacy(), observation.ip, interfaces)!
        const tcpProbe = vi.fn(async () => false)
        const report = await discoverDevices({ deadlineMs: 3000, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: true, tailnetHosts: [] },
            { interfaces, neighbors: async () => [], tcpProbe, tuyaBrowse: async () => [tuya, { ...tuya, host: '8.8.8.8' }] })
        expect(report.candidates.filter(c => c.via === 'udp')).toHaveLength(1)
        expect(tcpProbe.mock.calls.some(c => c[1] === 6668)).toBe(false)
        const dir = mkdtempSync(join(tmpdir(), 'tuya-view-'))
        try { recordCandidates(dir, [tuya]); const view = environmentAwareness(dir, 'owner'); expect(view).toContain('UDP-Geräteankündigung'); expect(view).not.toContain('beobachtete Ports 6668') }
        finally { rmSync(dir, { recursive: true, force: true }) }
        const browse = vi.fn(async () => [tuya])
        await discoverDevices({ deadlineMs: 3000, ratePerSec: 200, concurrency: 2, maxHosts: 1, mdns: false, tailnetHosts: [] }, { interfaces, neighbors: async () => [], tcpProbe, tuyaBrowse: browse })
        expect(browse).not.toHaveBeenCalled()
    })
    it('does not open sockets when disabled by stop or without an own private interface', async () => {
        const aborted = new AbortController(); aborted.abort()
        expect(await realTuyaBrowse(100, interfaces, aborted.signal)).toEqual([])
        expect(await realTuyaBrowse(100, {})).toEqual([])
    })
    it('bounds socket lifetime, emits only scoped discovery queries and cleans up all listeners on stop', async () => {
        const sockets: any[] = []
        class FakeSocket extends EventEmitter {
            close = vi.fn()
            setBroadcast = vi.fn()
            bind = vi.fn((_port, _address, callback) => callback())
            send = vi.fn((_packet, port, address, callback) => {
                expect(port).toBe(7000); expect(address).toBe('192.168.1.255')
                this.emit('message', modern(), { address: observation.ip })
                this.emit('message', modern(), { address: observation.ip })
                callback()
            })
        }
        const factory = () => { const socket = new FakeSocket(); sockets.push(socket); return socket as any }
        const abort = new AbortController()
        const browsing = realTuyaBrowse(3000, interfaces, abort.signal, factory)
        abort.abort()
        expect(await browsing).toHaveLength(1)
        expect(sockets).toHaveLength(4)
        expect(sockets.every(s => s.close.mock.calls.length === 1)).toBe(true)
        expect(sockets.reduce((n, s) => n + s.send.mock.calls.length, 0)).toBe(1)
    })
})
