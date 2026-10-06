import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consolidateDevices, migrateDeviceRegistry, readHostAliases, recordHostAliases, isNoiseCandidate } from './device-consolidation.js'
import { tailnetPeerLanAliases, parseMdnsResponse, mdnsCandidates } from './discovery.js'
import type { DeviceRecord } from './device-registry.js'

const at = '2026-10-06T10:00:00.000Z'
let n = 0
const rec = (p: Partial<DeviceRecord> & Pick<DeviceRecord, 'type' | 'host' | 'port'>): DeviceRecord => ({
    id: `dev-${(++n).toString(16).padStart(10, '0')}`, name: p.name || `${p.type} ${p.host}`, via: 'tcp', status: 'gefunden', foundAt: at, lastSeenAt: at, evidence: {}, ...p,
} as DeviceRecord)

/** The live finding of 06.10. rebuilt with documentation addresses only. */
function liveLikeRegistry(): DeviceRecord[] {
    n = 0
    return [
        // Home Assistant: same instance via LAN (mDNS uuid) and via the tailnet address.
        rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'mdns', evidence: { quelle: 'mDNS', service: '_home-assistant._tcp.local', uuid: 'aaaabbbbccccddddeeeeffff00001111' } }),
        rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http', evidence: { quelle: 'GET /manifest.json' } }),
        rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, via: 'http', evidence: { quelle: 'GET /manifest.json' } }),
        rec({ type: 'networkservice', host: '192.0.2.30', port: 445, evidence: { quelle: 'TCP-Connect' } }),
        // Hue bridge: mDNS, UPnP, three Matter announcements (two IPv6), plus an open port.
        rec({ type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', name: 'Hue Bridge - 0A1B2C', evidence: { quelle: 'mDNS', service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } }),
        rec({ type: 'networkservice', host: '192.0.2.143', port: 80, via: 'http', name: 'Signify Philips hue bridge 2015', hardware: { kind: 'unknown', label: 'Signify Philips hue bridge 2015', certainty: 'confirmed', identity: 'uuid:2f402f80-da50-11e1-9b23-001788aabbcc', manufacturer: 'Signify', model: 'Philips hue bridge 2015', observedAt: at }, evidence: { quelle: 'SSDP', geraetekennung: 'uuid:2f402f80-da50-11e1-9b23-001788aabbcc' } }),
        rec({ type: 'networkservice', host: '192.0.2.143', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'ABCDEF0123456789-0000000000000001', ecosystem: 'matter', connector: 'matter-ip', observedAt: at }, evidence: { service: '_matter._tcp.local' } }),
        rec({ type: 'networkservice', host: 'fe80::1%eth0', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'ABCDEF0123456789-0000000000000001', ecosystem: 'matter', connector: 'matter-ip', observedAt: at }, evidence: { service: '_matter._tcp.local' } }),
        rec({ type: 'networkservice', host: '2001:db8::143', port: 5540, via: 'mdns', hardware: { kind: 'unknown', label: 'Matter-Endpunkt', certainty: 'probable', identity: 'ABCDEF0123456789-0000000000000001', ecosystem: 'matter', connector: 'matter-ip', observedAt: at }, evidence: { service: '_matter._tcp.local' } }),
        rec({ type: 'networkservice', host: '192.0.2.143', port: 80, via: 'tcp', evidence: { quelle: 'TCP-Connect' } }),
        // Tuya plug (LAN announcement).
        rec({ type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', hardware: { kind: 'unknown', label: 'Tuya-kompatibles Gerät', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at } }),
        // Printer already set up — must stay.
        rec({ type: 'moonraker', host: '192.0.2.60', port: 7125, via: 'http', status: 'eingerichtet', approvedBy: 'auto:lesend', approvedAt: at }),
        // Rejected by the owner — the decision must survive.
        rec({ type: 'networkservice', host: '192.0.2.70', port: 8009, via: 'mdns', name: 'Beamer', status: 'abgelehnt', evidence: { service: '_googlecast._tcp.local' } }),
        // Noise: container bridges, own machine, own mesh node.
        rec({ type: 'networkservice', host: '172.17.0.2', port: 80 }),
        rec({ type: 'networkservice', host: '172.19.0.3', port: 5432 }),
        rec({ type: 'networkservice', host: '192.0.2.10', port: 22 }),
        rec({ type: 'networkservice', host: '192.0.2.10', port: 3011 }),
        rec({ type: 'networkservice', host: '192.0.2.40', port: 22 }),
        // Anonymous: only summarised.
        rec({ type: 'networkdevice', host: '192.0.2.99', port: 0, via: 'neighbor' }),
        rec({ type: 'networkservice', host: '192.0.2.98', port: 443 }),
        rec({ type: 'networkservice', host: '192.0.2.98', port: 80 }),
    ]
}

const ctx = { eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], meshAdressen: ['192.0.2.40', '198.51.100.40'], aliase: { '198.51.100.19': '192.0.2.30' } }

describe('Paket L 1: ein Eintrag je echtem Gerät', () => {
    it('merges Home Assistant over LAN + tailnet, Hue + its Matter announcements, filters noise', () => {
        const raw = liveLikeRegistry()
        const result = consolidateDevices(raw, ctx)
        expect(result.geraete.map(g => g.art).sort()).toEqual(['drucker', 'homeassistant', 'hue', 'tuya', 'tv'])
        const ha = result.geraete.find(g => g.art === 'homeassistant')!
        expect(ha.adressen.sort()).toEqual(['192.0.2.30', '198.51.100.19'])
        expect(ha.key).toBe('ha:aaaabbbbccccddddeeeeffff00001111')
        expect(ha.dienste.some(d => d.port === 445)).toBe(true)
        // the connect endpoint is the verified LAN http record
        expect(raw.find(r => r.id === ha.primaryId)).toMatchObject({ host: '192.0.2.30', via: 'http' })
        expect(ha.verbinden).toBe('homeassistant')
        const hue = result.geraete.find(g => g.art === 'hue')!
        expect(hue.key).toBe('hue:001788fffe0a1b2c')
        expect(hue.dienste.length).toBe(6)
        expect(hue.verbinden).toBe('hue')
        expect(result.geraete.find(g => g.art === 'tuya')!.verbinden).toBe('tuya')
        expect(result.rauschen).toBe(5)
        expect(result.ungeprueft).toBe(2) // .98 with open ports + .99 neighbour entry, summarised only
        expect(result.ungeprueftEintraege).toBe(3)
    })

    it('keeps owner decisions (abgelehnt / eingerichtet) on the merged device', () => {
        const result = consolidateDevices(liveLikeRegistry(), ctx)
        expect(result.geraete.find(g => g.art === 'tv')!.status).toBe('abgelehnt')
        expect(result.geraete.find(g => g.art === 'drucker')!.status).toBe('eingerichtet')
        expect(result.geraete.find(g => g.art === 'tv')!.verbinden).toBeNull()
    })

    it('an identified service on an own mesh node stays a device (HA on the NAS)', () => {
        n = 100
        const result = consolidateDevices([rec({ type: 'homeassistant', host: '192.0.2.40', port: 8123, via: 'http' }), rec({ type: 'networkservice', host: '192.0.2.40', port: 22 })], ctx)
        expect(result.geraete).toHaveLength(1)
        expect(result.geraete[0].art).toBe('homeassistant')
    })

    it('device ids are stable and contain no address', () => {
        const a = consolidateDevices(liveLikeRegistry(), ctx).geraete.map(g => g.id).sort()
        const b = consolidateDevices(liveLikeRegistry().reverse(), ctx).geraete.map(g => g.id).sort()
        expect(a).toEqual(b)
        for (const id of a) expect(id).toMatch(/^g-[a-f0-9]{10}$/)
    })

    it('noise candidates are not recorded any more', () => {
        expect(isNoiseCandidate({ type: 'networkservice', host: '172.17.0.2', port: 80, via: 'tcp' }, ctx)).toBe(true)
        expect(isNoiseCandidate({ type: 'networkservice', host: '192.0.2.10', port: 22, via: 'tcp' }, ctx)).toBe(true)
        expect(isNoiseCandidate({ type: 'networkservice', host: '192.0.2.40', port: 22, via: 'tcp' }, ctx)).toBe(true)
        expect(isNoiseCandidate({ type: 'homeassistant', host: '192.0.2.10', port: 8123, via: 'http' }, ctx)).toBe(false)
        expect(isNoiseCandidate({ type: 'networkservice', host: '192.0.2.98', port: 80, via: 'tcp' }, ctx)).toBe(false)
    })
})

describe('Paket L 1: Migration der vorhandenen devices.json', () => {
    it('writes the consolidated registry, leaves devices.json byte-identical and is idempotent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'pl-mig-'))
        mkdirSync(join(dir, 'sensing'), { recursive: true })
        const legacy = JSON.stringify({ version: 1, devices: liveLikeRegistry() })
        writeFileSync(join(dir, 'sensing', 'devices.json'), legacy)
        recordHostAliases(dir, { '198.51.100.19': '192.0.2.30' })
        const { aliase: _ignored, ...withoutAliases } = ctx
        const first = migrateDeviceRegistry(dir, withoutAliases)
        expect(readFileSync(join(dir, 'sensing', 'devices.json'), 'utf8')).toBe(legacy)
        expect(existsSync(join(dir, 'sensing', 'geraete.json'))).toBe(true)
        const stored = JSON.parse(readFileSync(join(dir, 'sensing', 'geraete.json'), 'utf8'))
        expect(stored.geraete).toHaveLength(5)
        // every raw entry is accounted for: in a device, as noise or summarised
        const members = stored.geraete.reduce((sum: number, g: any) => sum + g.dienste.length, 0)
        expect(members + stored.rauschen + stored.ungeprueftEintraege).toBe(liveLikeRegistry().length)
        expect(migrateDeviceRegistry(dir, withoutAliases)).toEqual(first)
        expect(readHostAliases(dir)).toEqual({ '198.51.100.19': '192.0.2.30' })
    })
})

describe('Paket L 1: stabile Kennungen aus der Erkennung', () => {
    it('reads LAN endpoints of tailnet peers (same machine over LAN + tailnet)', () => {
        const status = { Peer: { a: { TailscaleIPs: ['198.51.100.19'], Addrs: ['192.0.2.30:41641', '203.0.113.9:41641'], CurAddr: '' } } }
        const lan = (ip: string) => ip.startsWith('192.0.2.'), tail = (ip: string) => ip.startsWith('198.51.100.')
        expect(tailnetPeerLanAliases(status, lan, tail)).toEqual({ '198.51.100.19': '192.0.2.30' })
        // real defaults: documentation addresses are neither private LAN nor tailnet → nothing linked
        expect(tailnetPeerLanAliases(status)).toEqual({})
    })

    it('keeps the Home Assistant uuid and Hue bridge id from mDNS TXT records', () => {
        const name = (s: string) => Buffer.concat([...s.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])])
        const rr = (owner: string, type: number, data: Buffer) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([name(owner), h, data]) }
        const txt = (...items: string[]) => Buffer.concat(items.map(i => Buffer.concat([Buffer.from([i.length]), Buffer.from(i)])))
        const srv = (port: number, target: string) => { const b = Buffer.alloc(6); b.writeUInt16BE(port, 4); return Buffer.concat([b, name(target)]) }
        const records = [
            rr('_home-assistant._tcp.local', 12, name('Home._home-assistant._tcp.local')),
            rr('Home._home-assistant._tcp.local', 33, srv(8123, 'ha.local')),
            rr('Home._home-assistant._tcp.local', 16, txt('uuid=aaaabbbbccccddddeeeeffff00001111', 'version=2026.10.0')),
            rr('ha.local', 1, Buffer.from([192, 0, 2, 30])),
            rr('_hue._tcp.local', 12, name('Hue._hue._tcp.local')),
            rr('Hue._hue._tcp.local', 33, srv(443, 'hue.local')),
            rr('Hue._hue._tcp.local', 16, txt('bridgeid=001788fffe0a1b2c', 'modelid=BSB002')),
            rr('hue.local', 1, Buffer.from([192, 0, 2, 143])),
        ]
        const header = Buffer.alloc(12); header.writeUInt16BE(records.length, 6)
        const found = mdnsCandidates(parseMdnsResponse(Buffer.concat([header, ...records])))
        expect(found.find(f => f.type === 'homeassistant')?.hints?.uuid).toBe('aaaabbbbccccddddeeeeffff00001111')
        expect(found.find(f => f.hints?.service === '_hue._tcp.local')?.hints?.bridgeid).toBe('001788fffe0a1b2c')
    })
})
