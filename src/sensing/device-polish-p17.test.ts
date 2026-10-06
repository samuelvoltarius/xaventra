/**
 * 2.86.1 „Feinschliff“ (Owner 06.10.): die Geräteliste aus der Live-Antwort
 * auf „Welche smarten Geräte findest du?“ — nachgestellt nur mit Doku-Adressen
 * (192.0.2.x, 198.51.100.x) und generischen Namen.
 */
import { describe, expect, it } from 'vitest'
import { consolidateDevices, type KonsolidierungsKontext } from './device-consolidation.js'
import type { DeviceRecord } from './device-registry.js'

const at = '2026-10-06T10:00:00.000Z'
let n = 0
const rec = (p: Partial<DeviceRecord> & Pick<DeviceRecord, 'type' | 'host' | 'port'>): DeviceRecord => ({
    id: `dev-${(++n).toString(16).padStart(10, '0')}`, name: p.name || `${p.type} ${p.host}`, via: 'tcp', status: 'gefunden', foundAt: at, lastSeenAt: at, evidence: {}, ...p,
} as DeviceRecord)

const ctx: KonsolidierungsKontext = {
    eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], meshAdressen: ['198.51.100.40'],
    aliase: { '198.51.100.40': '192.0.2.40' }, eigeneNamen: ['main-host', 'nas-host'],
}

/** Die zwölf Zeilen der Live-Antwort, mit Testdaten nachgestellt. */
export function liveList(): DeviceRecord[] {
    n = 0
    return [
        rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'mdns', evidence: { quelle: 'mDNS', service: '_home-assistant._tcp.local', uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Zuhause', version: '2026.9.1' } }),
        // dieselbe Instanz über eine zweite Adresse ohne Tailscale-Adressmeldung — Kennung aus /api/discovery_info
        rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, via: 'http', evidence: { quelle: 'GET /manifest.json', uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Zuhause', version: '2026.9.1' } }),
        rec({ type: 'networkservice', host: '192.0.2.5', port: 6668, via: 'udp', hardware: { kind: 'unknown', label: 'Tuya-kompatibles Gerät', certainty: 'confirmed', identity: 'bf0123456789abcdef', ecosystem: 'tuya', connector: 'tuya-announcements', observedAt: at } }),
        rec({ type: 'networkservice', host: '192.0.2.143', port: 443, via: 'mdns', name: 'Hue Bridge - 0A1B2C', evidence: { quelle: 'mDNS', service: '_hue._tcp.local', bridgeid: '001788fffe0a1b2c' } }),
        // 3D-Drucker: Moonraker (eingerichtet) + Creality-Weboberfläche auf derselben Adresse
        rec({ type: 'moonraker', host: '192.0.2.60', port: 7125, via: 'http', status: 'eingerichtet', approvedBy: 'auto:lesend', approvedAt: at }),
        rec({ type: 'networkservice', host: '192.0.2.60', port: 80, via: 'mdns', name: 'K1C-0A1B', evidence: { quelle: 'mDNS', service: '_http._tcp.local', pageTitle: 'Creality' } }),
        // Fernseher: mDNS-Felder + eine Modell-Vermutung (nie in der Owner-Liste)
        rec({ type: 'networkservice', host: '192.0.2.50', port: 8009, via: 'mdns', name: 'Android-TV-0a1b2c3d4e5f', hardware: { kind: 'tv', label: 'Android TV via Chromecast/Media Cast', certainty: 'probable', observedAt: at }, evidence: { quelle: 'mDNS', service: '_googlecast._tcp.local', fn: 'Wohnzimmer', md: 'TCL Android TV' } }),
        rec({ type: 'networkservice', host: '192.0.2.51', port: 8009, via: 'mdns', name: 'MiTV-AXSO0', evidence: { quelle: 'mDNS', service: '_googlecast._tcp.local', fn: 'Xiaomi Mi TV Stick', md: 'MiTV-AXSO0' } }),
        rec({ type: 'networkservice', host: '192.0.2.21', port: 49152, via: 'mdns', name: 'Laptop von Beispiel', evidence: { quelle: 'mDNS', service: '_companion-link._tcp.local', model: 'MacBookAir10,1' } }),
        // Derselbe Laptop über WLAN + LAN: Name mit „(2)“-Suffix, gleiche Modellkennung
        rec({ type: 'networkservice', host: '192.0.2.22', port: 49152, via: 'mdns', name: 'MacBook Pro von Beispiel', evidence: { quelle: 'mDNS', service: '_companion-link._tcp.local', model: 'MacBookPro18,3' } }),
        rec({ type: 'networkservice', host: '192.0.2.23', port: 49152, via: 'mdns', name: 'MacBook Pro von Beispiel (2)', evidence: { quelle: 'mDNS', service: '_companion-link._tcp.local', model: 'MacBookPro18,3' } }),
        // der Main selbst über seine LAN-Adresse
        rec({ type: 'networkservice', host: '192.0.2.10', port: 22, via: 'mdns', name: 'main-host SSH', evidence: { quelle: 'mDNS', service: '_ssh._tcp.local' } }),
        rec({ type: 'networkservice', host: '192.0.2.1', port: 80, via: 'http', name: 'Technicolor CGA4233GA', hardware: { kind: 'unknown', label: 'Technicolor CGA4233GA', certainty: 'confirmed', identity: 'uuid:11112222-3333-4444-5555-666677778888', manufacturer: 'Technicolor', model: 'CGA4233GA', observedAt: at }, evidence: { quelle: 'SSDP', geraetekennung: 'uuid:11112222-3333-4444-5555-666677778888' } }),
    ]
}
export const liveCtx = ctx

const titel = (records: DeviceRecord[], c: KonsolidierungsKontext = ctx) => consolidateDevices(records, c).geraete.map(g => g.titel)

describe('2.86.1 Punkt 2: Dubletten', () => {
    it('dasselbe Gerät auf derselben Adresse ist EIN Gerät (eingerichteter Eintrag gewinnt)', () => {
        const drucker = consolidateDevices(liveList(), ctx).geraete.filter(g => g.art === 'drucker')
        expect(drucker).toHaveLength(1)
        expect(drucker[0].status).toBe('eingerichtet')
        expect(drucker[0].titel).toBe('3D-Drucker (Creality)')
    })

    it('gleicher mDNS-Name mit „(2)“ + gleiche Modellkennung auf zwei Adressen wird zusammengeführt', () => {
        const laptops = consolidateDevices(liveList(), ctx).geraete.filter(g => /MacBook Pro/.test(g.titel))
        expect(laptops).toHaveLength(1)
        expect(laptops[0].adressen).toEqual(['192.0.2.22', '192.0.2.23'])
        expect(laptops[0].titel).toBe('MacBook Pro von Beispiel')
    })

    it('ohne gemeinsames Merkmal: durchnummeriert, nie zwei identische Zeilen', () => {
        n = 0
        const list = [
            rec({ type: 'networkservice', host: '192.0.2.22', port: 49152, via: 'mdns', name: 'MacBook Pro von Beispiel', evidence: { service: '_companion-link._tcp.local', model: 'MacBookPro18,3' } }),
            rec({ type: 'networkservice', host: '192.0.2.23', port: 49152, via: 'mdns', name: 'MacBook Pro von Beispiel', evidence: { service: '_companion-link._tcp.local', model: 'MacBookPro16,1' } }),
            rec({ type: 'networkservice', host: '192.0.2.31', port: 631, via: 'mdns', name: 'Drucker', evidence: { service: '_ipp._tcp.local' } }),
            rec({ type: 'networkservice', host: '192.0.2.32', port: 631, via: 'mdns', name: 'Drucker', evidence: { service: '_ipp._tcp.local' } }),
        ]
        const names = titel(list)
        expect(new Set(names).size).toBe(names.length)
        expect(names).toContain('MacBook Pro von Beispiel (2)')
    })
})

describe('2.86.1 Punkt 3: eigene Knoten raus, ihre Dienste bleiben', () => {
    it('der Main (auch über seine LAN-Adresse) und Mesh-Knoten stehen nicht in der Geräteliste', () => {
        const list = [
            ...liveList(),
            rec({ type: 'networkservice', host: '192.0.2.40', port: 445, via: 'mdns', name: 'Speicher', evidence: { service: '_smb._tcp.local' } }),
            rec({ type: 'networkservice', host: '192.0.2.41', port: 22, via: 'mdns', name: 'nas-host SSH', evidence: { service: '_ssh._tcp.local' } }),
            rec({ type: 'n8n', host: '192.0.2.41', port: 5678, via: 'http' }),
            // Home Assistant auf dem eigenen NAS bleibt ein Gerät (zum Verbinden)
            rec({ type: 'homeassistant', host: '192.0.2.41', port: 8123, via: 'http', evidence: { uuid: '9999bbbbccccddddeeeeffff00001111' } }),
        ]
        const k = consolidateDevices(list, ctx)
        const text = k.geraete.map(g => g.titel).join('\n')
        expect(text).not.toMatch(/main-host|nas-host|SSH|Speicher|n8n/)
        expect(k.geraete.flatMap(g => g.adressen)).not.toContain('192.0.2.10')
        expect(k.geraete.flatMap(g => g.adressen)).not.toContain('192.0.2.40')
        expect(k.geraete.filter(g => g.art === 'homeassistant').map(g => g.adressen)).toContainEqual(['192.0.2.41'])
        // nicht verworfen: die Dienste eigener Knoten stehen in der Dienste-Liste
        expect(k.eigeneDienste.map(d => d.typ)).toContain('n8n')
        expect(k.eigeneDienste.find(d => d.typ === 'n8n')!.titel).toBe('Automationen (n8n)')
    })
})

describe('2.86.1 Punkt 4: Alltagsnamen', () => {
    it('Gerätetyp-Wort vorne, Name aus mDNS-Feldern, Hersteller in Klammern, keine Vermutungstexte', () => {
        const names = titel(liveList())
        expect(names).toContain('Fernseher Wohnzimmer (TCL)')
        expect(names).toContain('Router (Technicolor)')
        expect(names).toContain('TV-Stick (Xiaomi)')
        expect(names).toContain('Laptop von Beispiel')
        expect(names.join('\n')).not.toMatch(/via Chromecast|Media Cast|CGA4233GA|MiTV-AXSO0/)
    })

    it('ein Papier-Drucker ist kein 3D-Drucker', () => {
        n = 0
        expect(titel([rec({ type: 'networkservice', host: '192.0.2.31', port: 631, via: 'mdns', name: 'HP LaserJet 0A1B2C', evidence: { service: '_ipp._tcp.local', ty: 'HP LaserJet Pro', manufacturer: 'HP' } })])).toEqual(['Drucker (HP)'])
    })
})

describe('2.86.1 Ergänzung c: Home Assistant nicht doppelt', () => {
    it('gleiche Instanz-Kennung auf zwei Adressen = EIN Gerät, die Heimnetz-Adresse zuerst', () => {
        const list = liveList()
        const ha = consolidateDevices(list, { ...ctx, aliase: {} }).geraete.filter(g => g.art === 'homeassistant')
        expect(ha).toHaveLength(1)
        expect(ha[0].adressen).toEqual(['192.0.2.30', '198.51.100.19'])
        expect(list.find(r => r.id === ha[0].primaryId)!.host).toBe('192.0.2.30')
    })

    it('ohne Kennung: gleicher Instanzname + Version auf zwei Adressen = EIN Gerät', () => {
        n = 0
        const list = [
            rec({ type: 'homeassistant', host: '198.51.100.19', port: 8123, via: 'http', evidence: { location_name: 'Zuhause', version: '2026.9.1' } }),
            rec({ type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http', evidence: { location_name: 'Zuhause', version: '2026.9.1' } }),
        ]
        const ha = consolidateDevices(list, { ...ctx, aliase: {} }).geraete
        expect(ha).toHaveLength(1)
        expect(list.find(r => r.id === ha[0].primaryId)!.host).toBe('192.0.2.30')
    })
})

describe('2.86.1: die Live-Liste vorher/nachher', () => {
    it('zwölf Zeilen werden zu neun eindeutigen Alltagszeilen', () => {
        expect(titel(liveList())).toEqual([
            'Home Assistant', 'Hue Bridge', 'Tuya-Gerät', '3D-Drucker (Creality)', 'Fernseher Wohnzimmer (TCL)', 'TV-Stick (Xiaomi)',
            'Laptop von Beispiel', 'MacBook Pro von Beispiel', 'Router (Technicolor)',
        ])
    })
})

describe('2.86.1 Ergänzung c: Instanz-Kennung lesend erfragen', () => {
    it('/api/discovery_info liefert Kennung, Ort und Version (nur diese Felder, begrenzt)', async () => {
        const { parseHaDiscoveryInfo } = await import('./discovery.js')
        expect(parseHaDiscoveryInfo({ status: 200, body: JSON.stringify({ uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Zuhause', version: '2026.9.1', base_url: 'http://192.0.2.30:8123', requires_api_password: true }) }))
            .toEqual({ uuid: 'aaaabbbbccccddddeeeeffff00001111', location_name: 'Zuhause', version: '2026.9.1' })
        expect(parseHaDiscoveryInfo({ status: 404, body: '' })).toEqual({})
        expect(parseHaDiscoveryInfo({ status: 200, body: '<html>' })).toEqual({})
        expect(parseHaDiscoveryInfo({ status: 200, body: JSON.stringify({ uuid: 'x; rm -rf', version: 'neu' }) })).toEqual({})
    })
})

describe('2.86.1 Punkt 1: „Details“ sagen ehrlich, wie weit die Suche kam', () => {
    it('die letzte Suche (Adressen, Prüfungen, Teilsuche) steht in einer Alltagszeile', async () => {
        const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { geraeteDetails } = await import('./device-overview.js')
        const dir = mkdtempSync(join(tmpdir(), 'p17-details-'))
        mkdirSync(join(dir, 'sensing'), { recursive: true })
        writeFileSync(join(dir, 'sensing', 'last-discovery.json'), JSON.stringify({ observedAt: '2026-10-06T10:00:00.000Z', scannedHosts: 69, probes: 1248, partial: true }))
        const leer = geraeteDetails(dir, { geraete: [], rauschen: 0, rauschGruende: {}, ungeprueft: 0, ungeprueftEintraege: 0, eigeneDienste: [] }, () => false)
        expect(leer).toContain('Letzte Suche: 69 Adressen, 1248 Prüfungen – Teilsuche, nicht das ganze Netz.')
        const voll = geraeteDetails(dir, consolidateDevices(liveList(), ctx), () => false)
        expect(voll).toContain('69 Adressen, 1248 Prüfungen')
        expect(voll.length).toBeLessThanOrEqual(1100)
    })
})
