import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyHaDeviceMetadata, haDeviceTemplate } from './ha-device-metadata.js'
import { loeseAuf, mitHueRaeumen, parseHueRaeume, parseSchaltSatz, raumAusName, raumIndex, type RaumFunktion } from './rooms.js'

// 2.86 Paket N, Punkt 6: Räume aus Hue-Gruppen, HA-Bereichen und Namen; Sätze
// deterministisch verstanden, Mehrdeutigkeit = EINE Rückfrage. Keine Netzaufrufe.
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const f = (functionId: string, name: string, raum: string | undefined, art: 'licht' | 'schalter' = 'licht', schaltbar = true): RaumFunktion =>
    ({ quelle: 'direkt', deviceId: 'dev-00000000a1', functionId, name, art, raum, schaltbar })

describe('Räume zuordnen', () => {
    it('Hue-Räume (Räume vor Zonen) hängen an den Lampen', () => {
        const groups = { 1: { name: 'Wohnzimmer', type: 'Room', lights: ['1', '2'] }, 2: { name: 'Abends', type: 'Zone', lights: ['1', '3'] }, 3: { name: 'x', type: 'LightGroup', lights: ['4'] }, abc: { name: 'kaputt', type: 'Room', lights: ['5'] } }
        const raeume = parseHueRaeume(groups)
        expect(raeume).toEqual({ 1: 'Wohnzimmer', 2: 'Wohnzimmer', 3: 'Abends' })
        expect(mitHueRaeumen([{ id: 'light:1', kind: 'light', name: 'Stehlampe' }, { id: 'sensor:9', kind: 'sensor', name: 'Bewegung' }], raeume))
            .toEqual([{ id: 'light:1', kind: 'light', name: 'Stehlampe', raum: 'Wohnzimmer' }, { id: 'sensor:9', kind: 'sensor', name: 'Bewegung' }])
        expect(parseHueRaeume([1, 2])).toEqual({})
    })

    it('Home-Assistant-Bereiche kommen lesend aus dem festen Registerauszug', () => {
        expect(haDeviceTemplate([{ id: 'light.kitchen', name: 'Kitchen', kind: 'Lichtfunktion', state: 'on', available: true }])).toContain("'area': area_name(e)")
        const fn = { id: 'light.kitchen', name: 'Kitchen', kind: 'Lichtfunktion', state: 'on', available: true }
        expect(applyHaDeviceMetadata([fn], [{ entity_id: 'light.kitchen', device_id: 'a'.repeat(32), area: 'Küche' }])[0].raum).toBe('Küche')
        // ohne gültige Geräte-Id bleibt der Bereich trotzdem (er hängt an der Entität)
        expect(applyHaDeviceMetadata([fn], [{ entity_id: 'light.kitchen', device_id: null, area: 'Flur' }])[0].raum).toBe('Flur')
        expect(applyHaDeviceMetadata([fn], [{ entity_id: 'light.kitchen', device_id: null, area: 'None' }])[0].raum).toBeUndefined()
    })

    it('Namen: „Wohnzimmer Stehlampe“, „Küchenlicht“, „Badlampe“; „Deckenlicht“ ist kein Raum', () => {
        expect(raumAusName('Wohnzimmer Stehlampe')).toBe('Wohnzimmer')
        expect(raumAusName('Küchenlicht')).toBe('Küche')
        expect(raumAusName('Badezimmer Spiegel')).toBe('Badezimmer')
        expect(raumAusName('Deckenlicht')).toBeUndefined()
    })

    it('Index: HA-Funktionen sichtbar mit Bereich, aber nicht schaltbar', () => {
        const dir = mkdtempSync(join(tmpdir(), 'p16-rooms-')); dirs.push(dir)
        mkdirSync(join(dir, 'sensing'), { recursive: true })
        writeFileSync(join(dir, 'sensing', 'ha-inventory.json'), JSON.stringify({ version: 1, sources: [{ source: 'ha', at: new Date().toISOString(), status: 'ok', truncated: false,
            functions: [{ id: 'light.decke', name: 'Decke', kind: 'Lichtfunktion', state: 'on', available: true, raum: 'Flur' }, { id: 'sensor.t', name: 'T', kind: 'x', state: 'on', available: true }] }] }))
        const index = raumIndex(dir, [])
        expect(index).toEqual([{ quelle: 'homeassistant', functionId: 'light.decke', name: 'Decke', art: 'licht', raum: 'Flur', raumQuelle: 'homeassistant', schaltbar: false }])
        expect(loeseAuf(index, { on: false, was: 'licht', raum: 'flur' })).toEqual({ art: 'nicht-schaltbar', satz: 'Das sehe ich nur über Home Assistant. Dort kann ich noch nicht schalten; ich habe nichts verändert.' })
        expect(readFileSync(join(dir, 'sensing', 'ha-inventory.json'), 'utf8')).not.toContain('schaltbar')
    })
})

describe('Sätze verstehen (feste Muster)', () => {
    it.each([
        ['Licht im Wohnzimmer aus', { on: false, was: 'licht', raum: 'wohnzimmer' }],
        ['Mach bitte das Wohnzimmerlicht aus!', { on: false, was: 'licht', raum: 'wohnzimmer' }],
        ['schalte die Lampen in der Küche ein', { on: true, was: 'licht', raum: 'kueche' }],
        ['alles aus', { on: false, was: 'alles' }],
        ['Wohnzimmer aus', { on: false, was: 'name', name: 'wohnzimmer' }],
        ['Steckdose Flur an', { on: true, was: 'schalter', raum: 'flur' }],
        ['mach die Stehlampe aus', { on: false, was: 'name', name: 'stehlampe' }],
        ['Deckenlicht an', { on: true, was: 'name', name: 'deckenlicht' }],
    ])('%s', (text, expected) => { expect(parseSchaltSatz(text)).toEqual(expected) })

    it.each(['Ist das Licht im Wohnzimmer aus?', 'ist das licht aus', 'Wie geht das Licht aus', 'Ich finde das sieht gut aus und so weiter und so fort im Garten aus', 'Licht', 'Geht heute jemand aus mit mir zum Essen in die Stadt und dann'])('kein Schaltsatz: %s', text => {
        const satz = parseSchaltSatz(text)
        expect(satz === null || satz.was === 'name').toBe(true)
        if (satz) expect(loeseAuf([f('light:1', 'Stehlampe', 'Wohnzimmer')], satz).art).not.toBe('ziele')
    })
})

describe('Eindeutig auflösen', () => {
    const index = [f('light:1', 'Stehlampe', 'Wohnzimmer'), f('light:2', 'Decke', 'Schlafzimmer'), f('switch:0', 'Steckdose', 'Wohnzimmer', 'schalter'), f('light:3', 'Lesen', 'Kinderzimmer', 'licht', false)]
    it('ein Raum → genau seine schaltbaren Funktionen dieser Art', () => {
        expect(loeseAuf(index, { on: false, was: 'licht', raum: 'wohnzimmer' })).toEqual({ art: 'ziele', ziele: [index[0]], raum: 'Wohnzimmer' })
        expect(loeseAuf(index, { on: false, was: 'name', name: 'wohnzimmer' })).toEqual({ art: 'ziele', ziele: [index[0], index[2]], raum: 'Wohnzimmer' })
    })
    it('„Zimmer“ passt auf mehrere Räume → EINE Frage mit Räumen als Knöpfen', () => {
        const result = loeseAuf(index, { on: false, was: 'licht', raum: 'zimmer' })
        expect(result.art).toBe('wahl')
        if (result.art === 'wahl') expect(result.optionen.map(o => o.label)).toEqual(['Wohnzimmer', 'Schlafzimmer'])
    })
    it('„alles aus“ heißt ausdrücklich überall (nur Schaltbares)', () => {
        const result = loeseAuf(index, { on: false, was: 'alles' })
        expect(result).toEqual({ art: 'ziele', ziele: [index[0], index[1], index[2]] })
    })
})
