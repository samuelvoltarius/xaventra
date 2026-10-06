/** A route choice is per identity and never authorizes control, credentials or
 * silent local/cloud fallback. No model decision can substitute for owner consent. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { loadDevices, sensingDeviceFingerprint, type Approver, type DeviceRecord } from './device-registry.js'
import type { RawEvent } from './event-bus.js'
import { cleanText } from './ports.js'
export type SmartRoute = 'local' | 'cloud'
const path = (root: string) => join(root, 'sensing', 'smart-routes.json')
function read(root: string): Record<string, { fingerprint: string; owner: string; route: SmartRoute; approved?: boolean }> { try { const v = JSON.parse(readFileSync(path(root), 'utf8')).choices; return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
export function selectedSmartRoute(root: string, d: DeviceRecord): SmartRoute | undefined {
    const choice = read(root)[d.id]
    return choice && choice.owner && choice.fingerprint === sensingDeviceFingerprint(d) && ['local', 'cloud'].includes(choice.route) ? choice.route : undefined
}
export function approvedSmartRoute(root: string, d: DeviceRecord): SmartRoute | undefined {
    const choice = read(root)[d.id]
    return d.status === 'eingerichtet' && choice?.approved === true && choice.owner === d.approvedBy ? selectedSmartRoute(root, d) : undefined
}
/** Separate from choosing: invoked only after the explicit connection approval. */
export function approveSmartRoute(root: string, d: DeviceRecord, route: SmartRoute, owner: string): boolean {
    const choices = read(root), choice = choices[d.id]
    if (d.status !== 'eingerichtet' || d.approvedBy !== owner || choice?.owner !== owner || choice.route !== route || choice.fingerprint !== sensingDeviceFingerprint(d)) return false
    choice.approved = true
    atomicWriteJsonSync(path(root), { version: 1, choices }); return true
}
export function chooseSmartRoute(root: string, id: string, route: unknown, approver: Approver, now = Date.now()): { ok: boolean; message: string } {
    if (approver.permission !== 'owner' || !approver.principalId?.trim()) return { ok: false, message: 'Nur der authentifizierte Owner kann den Zugriffsweg wählen.' }
    if (route !== 'local' && route !== 'cloud') return { ok: false, message: 'Bitte lokal oder cloud wählen.' }
    const device = loadDevices(root).find(d => d.id === id)
    if (!device || ['aus', 'abgelehnt'].includes(device.status) || !Number.isFinite(Date.parse(device.lastSeenAt)) || now < Date.parse(device.lastSeenAt) || now - Date.parse(device.lastSeenAt) > 24 * 3600_000)
        return { ok: false, message: 'Gerätefund fehlt, ist veraltet oder wurde abgelehnt. Kein Zugriffsweg geändert.' }
    const choices = read(root); choices[id] = { fingerprint: sensingDeviceFingerprint(device), owner: approver.principalId, route, approved: false }
    mkdirSync(join(root, 'sensing'), { recursive: true, mode: 0o700 }); atomicWriteJsonSync(path(root), { version: 1, choices })
    return { ok: true, message: `${id}: ${route === 'local' ? 'lokaler' : 'Cloud-'} Weg gewählt. Noch keine Verbindung, kein Pairing und kein Schalten freigegeben. Verbindung separat bestätigen: /geraete ja ${id}. Fehlender Zugang wird separat angefragt; kein automatischer Wechsel auf den anderen Weg.` }
}
export function smartRouteEvents(root: string): RawEvent[] {
    return loadDevices(root).filter(d => d.status === 'gefunden' && Date.now() >= Date.parse(d.lastSeenAt) && Date.now() - Date.parse(d.lastSeenAt) <= 24 * 3600_000 && !selectedSmartRoute(root, d) && (d.hardware?.connector || /hue|esphome|matter|tasmota|shelly|tuya/i.test(JSON.stringify(d.evidence)))).slice(0, 16).map(d => ({
        kind: 'smart.route-choice', subject: d.id, severity: 'info', dedupeKey: `smart-route:${d.id}:${sensingDeviceFingerprint(d)}`, dedupeWindowMs: 365 * 24 * 3600_000,
        summary: `${d.hardware?.label || d.name}: Möchtest du den lokalen Weg oder die Hersteller-Cloud? ${smartRouteSupport(d)} Lokal benötigt gegebenenfalls Pairing/Schlüssel, Cloud einen gesonderten Herstellerzugang.`,
        evidence: { geraet: d.id, fingerprint: sensingDeviceFingerprint(d), adresse: d.host },
        // Multi-choice text, not a binary Ja card with no selection executor.
        hint: { importance: 'normal', level: 'selbst', proposal: `Gemeinsam wählen: /geraete weg ${d.id} lokal oder /geraete weg ${d.id} cloud. Die Wahl allein schaltet nichts und verbindet nichts.` },
    }))
}
export function smartRouteSupport(d: DeviceRecord): string {
    if (d.hardware?.connector === 'matter-ip') return 'Matter über WLAN/LAN und geroutetes Thread: lokales, separat bestätigtes Multi-Admin-Pairing und private Fabric-Zugangsdaten. Thread benötigt einen erreichbaren Border-Router; keine Hersteller-Cloud durch Matter selbst. Hersteller und Funktionen erst nach Zertifikatsprüfung und authentifizierter Abfrage bestätigt.'
    if (d.hardware?.connector === 'esphome-native') return 'ESPHome Native API: lokal verschlüsselte Funktionsabfrage mit API Encryption-Key. ESPHome selbst hat keine Hersteller-Cloud; ein anderer Cloud-Dienst braucht einen eigenen Adapter und eine eigene Freigabe.'
    if (d.hardware?.connector === 'tuya-announcements') return 'Lokal: verschlüsselter lesender Zugriff mit privatem Local-Key für 3.1/3.3/3.4/3.5; Datenpunkte sind ohne belegtes Schema noch keine Geräteart. Cloud: Funktionsschema lesbar mit separat eingerichtetem Tuya-API-Zugang; noch keine Steuerung.'
    if (d.hardware?.connector === 'shelly-readonly') return 'Lokal: direktes Funktionsinventar. Cloud: aktueller Shelly-v2-Status für genau die erkannte Gerätekennung, mit separat privat eingegebenem Shelly-Zugang; keine Steuerung aus der Verbindungsfreigabe.'
    if (['hue-readonly', 'tasmota-readonly'].includes(d.hardware?.connector)) return 'Lokal: Funktionsinventar unterstützt; Hue benötigt Bridge-Pairing. Hersteller-Cloud für dieses Protokoll noch nicht implementiert.'
    return 'Beide Wege müssen für diesen Gerätetyp erst auf einen verfügbaren Adapter geprüft werden; noch kein bestätigter Zugang.'
}
export function smartRouteAwareness(root: string): string {
    const devices = loadDevices(root).filter(d => d.hardware?.connector && !['aus', 'abgelehnt'].includes(d.status)).slice(0, 16)
    return ['Smart-Geräte-Zugriffswege (keine Schaltfreigabe):', ...devices.map(d => {
        const route = selectedSmartRoute(root, d)
        return `${cleanText(d.id, 32)}: ${route ? route === 'local' ? 'lokal gewählt' : 'Cloud gewählt' : 'Owner-Wahl lokal/Cloud noch offen'}; ${approvedSmartRoute(root, d) ? 'lesender Weg freigegeben, tatsächliches Ergebnis separat prüfen' : 'Verbindungsfreigabe noch offen'}. ${smartRouteSupport(d)}`
    })].join('\n').slice(0, 6000)
}
