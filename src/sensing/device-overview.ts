/**
 * 2.86 Paket N (Live-Befund 06.10.): „Welche smarten Geräte findest du?“
 * antwortet dem Owner mit der zusammengeführten Geräteliste in
 * Alltagssprache — Ampel + ein Satz, eine Zeile je echtem Gerät mit Nutzen
 * bzw. Zustand, höchstens ~600 Zeichen, keine Geräte-Ids und keine
 * Fachwörter. Knoten-Fähigkeiten, Arbeitswege, Zugriffswege und
 * Rohbeobachtungen (environment_inventory `formatted`) stehen nur noch hinter
 * „Details“ (`DETAILS_TRENNER`, owner-text.ts `paginate`). Offene
 * Verbinden-Fragen hängen als die EINE Bündel-Nachricht „Geräte gefunden“ an.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConnections } from '../connections/connection-store.js'
import { DETAILS_TRENNER, OWNER_PAGE_CHARS, ownerText } from '../core/owner-text.js'
import type { Geraet, Konsolidierung } from './device-consolidation.js'
import { loadDevices, type DeviceRecord } from './device-registry.js'
import { fachwoerterIn } from './device-words.js'

export { DETAILS_TRENNER }

const readJson = (file: string): any => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/** Alltagsname eines Geräts (Markennamen bleiben, Fachbegriffe nicht). */
export function alltagsTitel(g: Pick<Geraet, 'art' | 'titel'>): string {
    // 2.86.1: the consolidation already builds the everyday name (type word, own name, brand);
    // the brand in brackets and the number of a second device of the same name stay.
    if (g.art === 'matter') return /^Matter-Gerät( \(\d+\))?$/.test(g.titel) ? g.titel.replace('Matter-Gerät', 'Smart-Gerät') : 'Smart-Gerät'
    const titel = ownerText(g.titel).trim()
    return !titel || fachwoerterIn(titel).length ? 'Gerät im Netz' : titel
}

const plural = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`

function zaehleDirekt(dataDir: string, ids: Set<string>): { lampen: number; schalter: number; sensoren: number } {
    const rows = readJson(join(dataDir, 'sensing', 'direct-inventory.json'))?.devices
    const out = { lampen: 0, schalter: 0, sensoren: 0 }
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || row.status !== 'ok' || !ids.has(row.deviceId) || !Array.isArray(row.functions)) continue
        for (const f of row.functions) {
            if (f?.kind === 'light') out.lampen++
            else if (f?.kind === 'switch') out.schalter++
            else if (['sensor', 'binary_sensor'].includes(f?.kind)) out.sensoren++
        }
    }
    return out
}

function zaehleHa(dataDir: string): { lampen: number; schalter: number } {
    const sources = readJson(join(dataDir, 'sensing', 'ha-inventory.json'))?.sources
    const out = { lampen: 0, schalter: 0 }
    for (const s of Array.isArray(sources) ? sources : []) {
        if (s?.status !== 'ok' || !Array.isArray(s.functions)) continue
        for (const f of s.functions) { if (String(f?.id).startsWith('light.')) out.lampen++; else if (String(f?.id).startsWith('switch.')) out.schalter++ }
    }
    return out
}

function teileText(z: { lampen?: number; schalter?: number; sensoren?: number }): string {
    return [z.lampen ? plural(z.lampen, 'Lampe', 'Lampen') : '', z.schalter ? plural(z.schalter, 'Schalter', 'Schalter') : '', z.sensoren ? plural(z.sensoren, 'Sensor', 'Sensoren') : ''].filter(Boolean).join(', ')
}

export type GeraeteZustand = 'wartet' | 'verbunden' | 'gefunden'

/** Zustand + Nutzen eines Geräts in wenigen Worten. */
export function geraetZeile(dataDir: string, g: Geraet, records: DeviceRecord[], verbunden: boolean): { zustand: GeraeteZustand; text: string } {
    const titel = alltagsTitel(g)
    if (g.art === 'drucker') {
        const an = records.some(r => g.dienste.some(d => d.id === r.id) && r.status === 'eingerichtet')
        return an ? { zustand: 'verbunden', text: `${titel} — ich sehe seinen Fortschritt` } : { zustand: 'gefunden', text: `${titel} — gefunden` }
    }
    if (g.verbinden && !verbunden) return { zustand: 'wartet', text: `${titel} — wartet aufs Verbinden` }
    if (verbunden && g.art === 'homeassistant') {
        const teile = teileText(zaehleHa(dataDir))
        return { zustand: 'verbunden', text: `${titel} — verbunden${teile ? `: ich sehe ${teile}` : ''}` }
    }
    if (verbunden) {
        const teile = teileText(zaehleDirekt(dataDir, new Set(records.filter(r => g.dienste.some(d => d.id === r.id) || r.host === g.dienste[0]?.adresse.split(':')[0]).map(r => r.id))))
        return { zustand: 'verbunden', text: `${titel} — verbunden${teile ? `: ich sehe ${teile}` : ''}` }
    }
    return { zustand: g.status === 'eingerichtet' ? 'verbunden' : 'gefunden', text: `${titel} — ${g.status === 'eingerichtet' ? 'verbunden, nur lesen' : 'gefunden'}` }
}

/**
 * Die Owner-Antwort auf Geräte-Fragen. `istVerbunden` prüft je Gerät den
 * bestehenden Verbindungsweg (Standard: device-connect `isDeviceConnected`).
 */
export function geraeteUeberblick(dataDir: string, k: Konsolidierung, istVerbunden: (g: Geraet) => boolean, max = OWNER_PAGE_CHARS): string {
    const records = loadDevices(dataDir)
    const sichtbar = k.geraete.filter(g => g.status !== 'abgelehnt' && g.status !== 'aus')
    if (!sichtbar.length) return '🟢 Ich habe in deinem Netz noch keine Geräte gefunden. Ich suche von selbst weiter und sage Bescheid, sobald ich etwas finde.'
    const zeilen = sichtbar.map(g => geraetZeile(dataDir, g, records, (() => { try { return istVerbunden(g) } catch { return false } })()))
    const wartet = zeilen.filter(z => z.zustand === 'wartet').length
    const kopf = `${wartet ? '🟡' : '🟢'} Ich kenne ${plural(sichtbar.length, 'Gerät', 'Geräte')} in deinem Netz${wartet ? ` — ${wartet === 1 ? 'eins wartet' : `${wartet} warten`} aufs Verbinden` : ''}.`
    const fuss = wartet ? 'Verbinden: je ein Knopf in der Nachricht „Geräte gefunden“.' : ''
    const out = [kopf]
    const reserve = fuss.length + 40
    let rest = zeilen.length
    // Wartende zuerst (dort ist etwas zu tun), dann verbundene, dann Funde.
    const rang: Record<GeraeteZustand, number> = { wartet: 0, verbunden: 1, gefunden: 2 }
    for (const zeile of [...zeilen].sort((a, b) => rang[a.zustand] - rang[b.zustand])) {
        const line = `• ${zeile.text}`
        if (out.join('\n').length + 1 + line.length > max - reserve) break
        out.push(line); rest--
    }
    if (rest > 0) out.push(`… und ${rest} weitere (unter „Mehr“).`)
    if (fuss) out.push(fuss)
    return out.join('\n')
}

/** Höchstlänge der „Details“ zur Geräteliste: zwei Telegram-Seiten. */
export const DETAILS_MAX_CHARS = 2 * OWNER_PAGE_CHARS - 100

const WEG_RANG: Record<string, number> = { mdns: 0, udp: 1, http: 2, tcp: 3, neighbor: 4 }
const WEG_TEXT: Record<string, string> = { mdns: 'meldet sich selbst im Netz', udp: 'meldet sich selbst im Netz', http: 'antwortet auf Nachfrage', tcp: 'ist im Netz erreichbar', neighbor: 'war im Netz zu sehen' }

/**
 * 2.86.1 Punkt 1: „Details“ zur Geräteliste — kurz und strukturiert, höchstens
 * zwei Seiten: je Gerät Adresse, wie ich es erkannt habe und der Stand, in
 * Alltagssprache. Knoten-Fähigkeiten, Arbeitswege, Anschlüsse und
 * Rohbeobachtungen gibt es nur auf ausdrückliche Nachfrage („technische
 * Details“) oder in der App.
 */
export function geraeteDetails(dataDir: string, k: Konsolidierung, istVerbunden: (g: Geraet) => boolean, max = DETAILS_MAX_CHARS): string {
    const records = loadDevices(dataDir)
    const sichtbar = k.geraete.filter(g => g.status !== 'abgelehnt' && g.status !== 'aus')
    if (!sichtbar.length) return 'Noch keine Geräte – ich suche von selbst weiter.'
    const out = ['So habe ich deine Geräte gefunden:']
    const fuss = 'Mehr zu jedem Gerät steht in der App unter „Verbindungen“.'
    let rest = sichtbar.length
    for (const g of sichtbar) {
        const zustand = geraetZeile(dataDir, g, records, (() => { try { return istVerbunden(g) } catch { return false } })()).zustand
        const weg = [...g.dienste].sort((a, b) => (WEG_RANG[a.via] ?? 9) - (WEG_RANG[b.via] ?? 9))[0]?.via || 'tcp'
        const adressen = g.adressen.filter(ip => !ip.includes(':')).slice(0, 2)
        const stand = zustand === 'verbunden' ? 'verbunden' : zustand === 'wartet' ? 'wartet aufs Verbinden' : 'nur gefunden'
        const line = `• ${alltagsTitel(g)}: ${adressen.length ? `${adressen.join(' und ')} · ` : ''}${WEG_TEXT[weg] || WEG_TEXT.tcp} · ${stand}`
        if (out.join('\n').length + 1 + line.length > max - fuss.length - 40) break
        out.push(line); rest--
    }
    if (rest > 0) out.push(`… und ${rest} weitere.`)
    out.push(fuss)
    return ownerText(out.join('\n'))
}

/** Produktion: Liste + die eine Verbinden-Bündelnachricht (neu zugestellt, wenn Fragen offen sind). */
export async function ownerGeraeteAntwort(dataDir: string, deps: { kick?: () => void | Promise<void> } = {}): Promise<string> {
    return (await ownerGeraeteAntworten(dataDir, deps)).text
}

/** 2.86.1: die Owner-Liste (eine Nachricht) und ihre kurzen „Details“ (höchstens zwei Seiten). */
export async function ownerGeraeteAntworten(dataDir: string, deps: { kick?: () => void | Promise<void> } = {}): Promise<{ text: string; details: string }> {
    const { loadConsolidatedDevices, defaultConsolidationContext } = await import('./device-consolidation.js')
    const { isDeviceConnected, offerDeviceConnections, DEVICE_BUNDLE } = await import('./device-connect.js')
    const ctx = await defaultConsolidationContext(dataDir)
    const k = await loadConsolidatedDevices(dataDir, ctx)
    const records = loadDevices(dataDir)
    let connections: ReturnType<typeof loadConnections> = []
    try { connections = loadConnections({ dataDir }) } catch { connections = [] }
    const verbunden = (g: Geraet) => g.art === 'homeassistant' ? connections.some(c => c.connectorId === 'home-assistant' && c.status === 'verbunden') : isDeviceConnected(dataDir, g, records)
    const text = geraeteUeberblick(dataDir, k, verbunden)
    const details = geraeteDetails(dataDir, k, verbunden)
    try {
        const { created } = await offerDeviceConnections({ dataDir, ctx })
        const { requestBundleResend } = await import('../core/card-bundle.js')
        if (created || /wartet|warten/.test(text.split('\n')[0])) requestBundleResend(DEVICE_BUNDLE, { dataDir })
        if (deps.kick) await deps.kick()
        else { const { runApprovalCardTick } = await import('../core/approval-card-sources.js'); void runApprovalCardTick() }
    } catch { /* die Liste gilt auch ohne Karte */ }
    return { text, details }
}
