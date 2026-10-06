/**
 * 2.86 Paket N (Live-Befund 06.10. 16:31): der laufende Verbindungsvorgang.
 *
 * - Nach einer erfolgreichen Kopplung kommt GENAU EINE Erfolgsnachricht als
 *   Nutzen-Satz über den einen Meldeweg (Wahrnehmen-Ereignis → Gedanke →
 *   Zustellung): „✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa,
 *   Wohnzimmer.“ Auch wenn die Taste erst nach dem Ja gedrückt wurde und die
 *   Kopplung im Hintergrund fertig wird.
 * - Kurze Rückfragen („und?“, „hat's geklappt?“) kurz danach beziehen sich auf
 *   den letzten Vorgang und werden aus dem Speicher beantwortet (läuft /
 *   verbunden / nicht geklappt) — ohne Modellrunde.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { RawEvent } from './event-bus.js'
import type { DirectFunction, DirectInventory } from './direct-smart-devices.js'
import { beispieleNachErfolg } from '../guided/example-prompts.js'

export type VorgangArt = 'hue' | 'homeassistant'
export type VorgangStatus = 'laeuft' | 'verbunden' | 'fehlgeschlagen'
export interface Vorgang { key: string; art: VorgangArt; status: VorgangStatus; startedAt: string; updatedAt: string; satz?: string; gemeldetAt?: string }

/** Wie lange „und?“ sich auf den letzten Vorgang bezieht. */
export const STAND_FENSTER_MS = 30 * 60_000
/** Länger wartet eine Hue-Kopplung nicht auf die Taste (direct-smart-devices: 2 Minuten + Puffer). */
const HUE_WARTEN_MS = 3 * 60_000

const file = (dataDir: string) => join(dataDir, 'sensing', 'verbindungs-vorgaenge.json')
function lade(dataDir: string): Vorgang[] {
    try { const raw = JSON.parse(readFileSync(file(dataDir), 'utf8')); return Array.isArray(raw?.vorgaenge) ? raw.vorgaenge : [] } catch { return [] }
}
function speichere(dataDir: string, list: Vorgang[]): void {
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(dataDir), { version: 1, vorgaenge: list.slice(-20) })
}

export function starteVorgang(dataDir: string, input: { key: string; art: VorgangArt }, now = Date.now()): Vorgang {
    const at = new Date(now).toISOString()
    const vorgang: Vorgang = { key: input.key, art: input.art, status: 'laeuft', startedAt: at, updatedAt: at }
    speichere(dataDir, [...lade(dataDir).filter(v => v.key !== input.key), vorgang])
    return vorgang
}

/** Ergebnis festhalten. `gemeldet` = der Owner hat den Satz schon gesehen (z. B. direkt auf der Karte). */
export function beendeVorgang(dataDir: string, key: string, status: Exclude<VorgangStatus, 'laeuft'>, satz: string, opts: { gemeldet?: boolean; now?: number } = {}): Vorgang | undefined {
    const list = lade(dataDir)
    const index = list.findIndex(v => v.key === key)
    if (index < 0) return undefined
    const at = new Date(opts.now ?? Date.now()).toISOString()
    const vorher = list[index].status
    list[index] = { ...list[index], status, satz, updatedAt: at, ...(opts.gemeldet ? { gemeldetAt: at } : {}) }
    speichere(dataDir, list)
    // 2.86 (N + M): after the success message the three example sentences — offered once,
    // by the same place as after every new connection (guided/example-prompts.ts).
    if (status === 'verbunden' && vorher !== 'verbunden') {
        try { beispieleNachErfolg(list[index].art, { dataDir, now: () => opts.now ?? Date.now() }) } catch { /* examples are a convenience */ }
    }
    return list[index]
}

export function letzterVorgang(dataDir: string, now = Date.now()): Vorgang | undefined {
    const recent = lade(dataDir).filter(v => now - Date.parse(v.updatedAt) <= STAND_FENSTER_MS)
    return recent.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)
}

/** „✅ Hue verbunden: 4 Lampen, 2 gerade erreichbar — Sofa, Wohnzimmer.“ */
export function hueErfolgsSatz(functions: readonly DirectFunction[]): string {
    const lampen = functions.filter(f => f?.kind === 'light')
    if (!lampen.length) return '✅ Hue verbunden. Lampen sehe ich dort gerade noch keine.'
    const da = lampen.filter(f => f.available === true)
    const teil = da.length === lampen.length ? 'alle erreichbar' : da.length === 0 ? 'gerade keine erreichbar' : `${da.length} gerade erreichbar — ${da.slice(0, 3).map(f => f.name).join(', ')}${da.length > 3 ? ' …' : ''}`
    return `✅ Hue verbunden: ${lampen.length === 1 ? '1 Lampe' : `${lampen.length} Lampen`}, ${teil}.`
}

/**
 * Wahrnehmen (direkte Geräte): eine laufende Hue-Kopplung ist fertig → GENAU
 * ein Ereignis mit dem Nutzen-Satz; danach nie wieder für diesen Vorgang.
 */
export function vorgangsEreignisse(dataDir: string, rows: readonly DirectInventory[], now = Date.now()): RawEvent[] {
    const events: RawEvent[] = []
    for (const row of rows) {
        if (row?.status !== 'ok' || row.protocol !== 'hue') continue
        const v = lade(dataDir).find(item => item.key === row.deviceId)
        if (!v || v.gemeldetAt || v.status === 'fehlgeschlagen') continue
        const satz = hueErfolgsSatz(row.functions)
        beendeVorgang(dataDir, row.deviceId, 'verbunden', satz, { gemeldet: true, now })
        events.push({ kind: 'smart.verbunden', subject: row.deviceId, severity: 'info', dedupeKey: `verbunden:${row.deviceId}:${v.startedAt}`, dedupeWindowMs: 24 * 3600_000,
            summary: satz, evidence: { geraet: row.deviceId, lampen: row.functions.filter(f => f.kind === 'light').length }, hint: { importance: 'normal', title: satz } })
    }
    return events
}

const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/** Antwort auf „und?“ / „hat's geklappt?“ ('' = kein Vorgang in letzter Zeit → normales Gespräch). */
export function vorgangsStand(dataDir: string, now = Date.now()): string {
    const v = letzterVorgang(dataDir, now)
    if (!v) return ''
    if (v.status !== 'laeuft') return v.satz || (v.status === 'verbunden' ? '✅ Verbunden.' : 'Das hat leider nicht geklappt.')
    if (v.art === 'hue') {
        const row = (readJson(join(dataDir, 'sensing', 'direct-inventory.json'))?.devices || []).find((r: any) => r?.deviceId === v.key)
        if (row?.status === 'ok') {
            const satz = hueErfolgsSatz(row.functions || [])
            beendeVorgang(dataDir, v.key, 'verbunden', satz, { gemeldet: true, now })
            return satz
        }
        const pairing = readJson(join(dataDir, 'sensing', 'smart-pairing.json'))?.[v.key]
        if (pairing?.status === 'expired' || now - Date.parse(v.startedAt) > HUE_WARTEN_MS) {
            const satz = 'Das hat nicht geklappt: Die Taste an der Hue Bridge kam nicht rechtzeitig an. Nochmal: unter „Geräte“ auf Verbinden drücken, dann die runde Taste und Ja.'
            beendeVorgang(dataDir, v.key, 'fehlgeschlagen', satz, { gemeldet: true, now })
            return satz
        }
        return 'Noch nicht fertig: Ich warte auf die runde Taste an der Hue Bridge. Drück sie jetzt, ich melde mich gleich.'
    }
    return 'Noch nicht fertig: Ich warte, bis du dich bei Home Assistant angemeldet hast (Knopf „Bei Home Assistant anmelden“).'
}
