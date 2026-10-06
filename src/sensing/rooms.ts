/**
 * 2.86 Paket N, Punkt 6 — Räume statt Geräte-IDs.
 *
 * Geräte werden automatisch Räumen zugeordnet, in dieser Reihenfolge:
 *  1. Hue-Räume/-Zonen (lesend `GET /api/<key>/groups`, direct-smart-devices.ts),
 *  2. Home-Assistant-Bereiche aus dem autorisierten HA-Inventar (`area_name`,
 *     ha-device-metadata.ts),
 *  3. der Name der Funktion („Wohnzimmer Stehlampe“, „Küchenlicht“),
 *  4. der Name des Geräts.
 *
 * Ein Satz wie „Licht im Wohnzimmer aus“ wird deterministisch verstanden
 * (`parseSchaltSatz`, feste Muster, kein Modell) und eindeutig aufgelöst
 * (`loeseAuf`). Ist er mehrdeutig, gibt es genau EINE Rückfrage mit Knöpfen
 * (Optionen); geschaltet wird nie aus einer Vermutung. Hier wird nur gelesen —
 * das Schalten selbst läuft über die Vorschau-Karte (device-switch.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDevices, sensingDeviceFingerprint, type DeviceRecord } from './device-registry.js'
import { approvedSmartRoute } from './smart-device-route.js'
import { switchSupported } from './smart-control.js'
import type { DirectFunction, DirectInventory } from './direct-smart-devices.js'
import { imRaum } from './device-words.js'
import { falte, raumAusName, raumName, type SchaltSatz } from './device-sentences.js'

export { RAEUME, falte, parseSchaltSatz, raumAusName, raumName, type SchaltSatz } from './device-sentences.js'


// ---------------------------------------------------------------------------
// Hue-Räume (lesend)
// ---------------------------------------------------------------------------

/** `GET /api/<key>/groups` → Lampen-Nummer → Raum. Räume vor Zonen; nur gültige Einträge. */
export function parseHueRaeume(body: unknown): Record<string, string> {
    const result: Record<string, string> = {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) return result
    const groups = Object.entries(body as Record<string, any>).slice(0, 100)
        .filter(([id, g]) => /^\d{1,8}$/.test(id) && g && ['Room', 'Zone'].includes(g.type) && typeof g.name === 'string' && Array.isArray(g.lights))
        .sort(([, a], [, b]) => (a.type === 'Room' ? 0 : 1) - (b.type === 'Room' ? 0 : 1))
    for (const [, g] of groups) {
        const name = raumName(g.name)
        if (!name) continue
        for (const light of g.lights.slice(0, 200)) if (/^\d{1,8}$/.test(String(light)) && !result[String(light)]) result[String(light)] = name
    }
    return result
}

/** Hängt den Hue-Raum an die Lampen-Funktionen (`light:<n>`). */
export function mitHueRaeumen(functions: DirectFunction[], raeume: Record<string, string>): DirectFunction[] {
    return functions.map(f => {
        const n = /^light:(\d{1,8})$/.exec(f.id)?.[1]
        return n && raeume[n] ? { ...f, raum: raeume[n] } : f
    })
}

// ---------------------------------------------------------------------------
// Raum-Index
// ---------------------------------------------------------------------------

export type FunktionsArt = 'licht' | 'schalter'
export interface RaumFunktion {
    quelle: 'direkt' | 'homeassistant'
    deviceId?: string
    functionId: string
    name: string
    art: FunktionsArt
    raum?: string
    raumQuelle?: 'hue' | 'homeassistant' | 'name' | 'geraet'
    /** true = es gibt einen bestätigten Schaltweg (sonst nur sichtbar). */
    schaltbar: boolean
}

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

function direktArt(kind: DirectFunction['kind']): FunktionsArt | null {
    return kind === 'light' ? 'licht' : kind === 'switch' ? 'schalter' : null
}

/**
 * Alle Licht-/Schalter-Funktionen mit Raum. Liest nur gespeicherte Bestände
 * (direct-inventory.json, ha-inventory.json); eine Funktion ist schaltbar,
 * wenn das Gerät eingerichtet ist, Fingerabdruck und Freigabe passen und der
 * bestehende Schaltweg sie unterstützt.
 */
export function raumIndex(dataDir: string, devices: DeviceRecord[] = loadDevices(dataDir)): RaumFunktion[] {
    const out: RaumFunktion[] = []
    const rows: DirectInventory[] = Array.isArray(readJson(join(dataDir, 'sensing', 'direct-inventory.json'))?.devices) ? readJson(join(dataDir, 'sensing', 'direct-inventory.json')).devices : []
    for (const row of rows.slice(0, 1000)) {
        if (!row || row.status !== 'ok' || !Array.isArray(row.functions)) continue
        const d = devices.find(item => item.id === row.deviceId)
        if (!d || d.status !== 'eingerichtet' || sensingDeviceFingerprint(d) !== row.fingerprint || d.approvedAt !== row.approvedAt) continue
        const route = approvedSmartRoute(dataDir, d)
        for (const f of row.functions.slice(0, 200)) {
            const art = f && direktArt(f.kind)
            if (!art || typeof f.id !== 'string') continue
            const vonName = raumAusName(f.name), vomGeraet = raumAusName(d.name)
            const raum = raumName(f.raum) || vonName || vomGeraet
            out.push({
                quelle: 'direkt', deviceId: d.id, functionId: f.id, name: String(f.name || d.name).slice(0, 80), art, raum,
                raumQuelle: f.raum ? 'hue' : vonName ? 'name' : vomGeraet ? 'geraet' : undefined,
                schaltbar: Boolean(route && switchSupported(d, f, route)),
            })
        }
    }
    const ha = readJson(join(dataDir, 'sensing', 'ha-inventory.json'))
    for (const source of (Array.isArray(ha?.sources) ? ha.sources : []).slice(0, 4)) {
        if (source?.status !== 'ok' || !Array.isArray(source.functions)) continue
        for (const f of source.functions.slice(0, 200)) {
            if (!f || typeof f.id !== 'string') continue
            const art: FunktionsArt | null = f.id.startsWith('light.') ? 'licht' : f.id.startsWith('switch.') ? 'schalter' : null
            if (!art) continue
            const vonName = raumAusName(f.name)
            const raum = raumName(f.raum) || vonName
            // Home Assistant schaltet Xaventra (noch) nicht: sichtbar, aber nicht schaltbar.
            out.push({ quelle: 'homeassistant', functionId: f.id, name: String(f.name || f.id).slice(0, 80), art, raum, raumQuelle: f.raum ? 'homeassistant' : vonName ? 'name' : undefined, schaltbar: false })
        }
    }
    return out
}

/** Räume mit ihren Funktionen (für Listen „im Wohnzimmer: …“). */
export function raeumeAus(index: readonly RaumFunktion[]): Array<{ raum: string; funktionen: RaumFunktion[] }> {
    const map = new Map<string, RaumFunktion[]>()
    for (const f of index) if (f.raum) map.set(f.raum, [...(map.get(f.raum) || []), f])
    return [...map.entries()].map(([raum, funktionen]) => ({ raum, funktionen })).sort((a, b) => a.raum.localeCompare(b.raum, 'de'))
}

// ---------------------------------------------------------------------------
// Auflösen
// ---------------------------------------------------------------------------

export interface AuswahlOption { label: string; ziele: RaumFunktion[] }
export type Aufloesung =
    | { art: 'ziele'; ziele: RaumFunktion[]; raum?: string }
    | { art: 'wahl'; frage: string; optionen: AuswahlOption[] }
    | { art: 'nicht-schaltbar'; satz: string }
    | { art: 'nichts'; satz: string }

const passtArt = (f: RaumFunktion, was: SchaltSatz['was']) => was === 'alles' || was === 'name' || (was === 'licht' ? f.art === 'licht' : f.art === 'schalter')

/** Räume, die zum gesagten Raumtext passen: genau gleich, sonst Teilwort („zimmer“ → mehrere). */
function passendeRaeume(index: readonly RaumFunktion[], gesagt: string): string[] {
    const all = [...new Set(index.map(f => f.raum).filter((r): r is string => Boolean(r)))]
    const key = falte(gesagt)
    const exact = all.filter(r => falte(r) === key || (raumAusName(key) && raumAusName(key) === r))
    if (exact.length) return exact
    return key.length >= 3 ? all.filter(r => falte(r).includes(key)) : []
}

const WAS_TEXT: Record<SchaltSatz['was'], string> = { licht: 'Lampen', schalter: 'Schalter', alles: 'Geräte', name: 'Geräte' }

/**
 * Löst einen Satz eindeutig auf. Nur schaltbare Funktionen werden Ziele;
 * Mehrdeutigkeit → EINE Frage mit Optionen (Räume bzw. Geräte), nie raten.
 */
export function loeseAuf(index: readonly RaumFunktion[], satz: SchaltSatz): Aufloesung {
    let kandidaten = index.filter(f => passtArt(f, satz.was))
    let raum: string | undefined
    if (satz.raum) {
        const raeume = passendeRaeume(index, satz.raum)
        if (!raeume.length) return { art: 'nichts', satz: `Einen Raum „${satz.raum}“ kenne ich noch nicht.${bekannteRaeume(index)}` }
        if (raeume.length > 1) {
            return wahlAus(raeume.map(r => ({ label: r, ziele: kandidaten.filter(f => f.raum === r && f.schaltbar) })).filter(o => o.ziele.length),
                `Welchen Raum meinst du?`, satz, index)
        }
        raum = raeume[0]
        kandidaten = kandidaten.filter(f => f.raum === raum)
    }
    if (satz.was === 'name') {
        const key = satz.name || ''
        // ein Raumname allein („Wohnzimmer aus“) heißt: alles in diesem Raum
        const alsRaum = !satz.raum ? passendeRaeume(index, key).filter(r => falte(r) === key || raumAusName(key) === r) : []
        if (alsRaum.length === 1) return loeseAuf(index, { on: satz.on, was: 'alles', raum: alsRaum[0] })
        const exact = kandidaten.filter(f => falte(f.name) === key)
        kandidaten = exact.length ? exact : kandidaten.filter(f => falte(f.name).includes(key) && key.length >= 3)
        if (!kandidaten.length) return { art: 'nichts', satz: '' }
        const schaltbar = kandidaten.filter(f => f.schaltbar)
        if (!schaltbar.length) return nichtSchaltbar(kandidaten)
        if (schaltbar.length > 1 && !exact.length) {
            return wahlAus(schaltbar.map(f => ({ label: f.raum && !falte(f.name).includes(falte(f.raum)) ? `${f.name} (${f.raum})` : f.name, ziele: [f] })), 'Welches Gerät meinst du?', satz, index)
        }
        return { art: 'ziele', ziele: schaltbar, ...(raum ? { raum } : {}) }
    }
    if (!kandidaten.length) return { art: 'nichts', satz: raum ? `${raumSatz(raum)} sehe ich keine ${WAS_TEXT[satz.was]}.` : `Ich sehe noch keine ${WAS_TEXT[satz.was]}, die ich schalten kann.` }
    const schaltbar = kandidaten.filter(f => f.schaltbar)
    if (!schaltbar.length) return nichtSchaltbar(kandidaten)
    // „Licht aus“ ohne Raum bei Lampen in mehreren Räumen → eine Rückfrage (alles = ausdrücklich überall)
    if (!raum && satz.was !== 'alles') {
        const raeume = [...new Set(schaltbar.map(f => f.raum || ''))]
        if (raeume.length > 1) {
            const optionen = raeume.filter(Boolean).map(r => ({ label: r, ziele: schaltbar.filter(f => f.raum === r) }))
            optionen.push({ label: 'Überall', ziele: schaltbar })
            return wahlAus(optionen, `${satz.was === 'licht' ? 'Welches Licht' : 'Welche Schalter'} meinst du?`, satz, index)
        }
    }
    return { art: 'ziele', ziele: schaltbar, ...(raum ? { raum } : {}) }
}

function wahlAus(optionen: AuswahlOption[], frage: string, satz: SchaltSatz, index: readonly RaumFunktion[]): Aufloesung {
    const valid = optionen.filter(o => o.ziele.length).slice(0, 6)
    if (!valid.length) return { art: 'nichts', satz: `Dazu finde ich nichts, das ich schalten kann.${bekannteRaeume(index)}` }
    if (valid.length === 1) return { art: 'ziele', ziele: valid[0].ziele }
    return { art: 'wahl', frage, optionen: valid }
}

const raumSatz = (raum: string) => { const text = imRaum(raum); return text.charAt(0).toUpperCase() + text.slice(1) }

function bekannteRaeume(index: readonly RaumFunktion[]): string {
    const raeume = [...new Set(index.filter(f => f.schaltbar).map(f => f.raum).filter(Boolean))].slice(0, 6)
    return raeume.length ? ` Ich kenne: ${raeume.join(', ')}.` : ''
}

function nichtSchaltbar(kandidaten: RaumFunktion[]): Aufloesung {
    const ha = kandidaten.some(f => f.quelle === 'homeassistant')
    return { art: 'nicht-schaltbar', satz: ha
        ? 'Das sehe ich nur über Home Assistant. Dort kann ich noch nicht schalten; ich habe nichts verändert.'
        : 'Das sehe ich, kann es aber noch nicht schalten; ich habe nichts verändert.' }
}
