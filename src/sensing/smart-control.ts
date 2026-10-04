/** Concrete, single-use owner confirmations. Discovery/LLM output cannot execute. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { loadDevices, sensingDeviceFingerprint, type Approver, type DeviceRecord } from './device-registry.js'
import { approvedSmartRoute } from './smart-device-route.js'
import { nativeAccessRevision } from './smart-device-access.js'
import type { DirectFunction, DirectInventory } from './direct-smart-devices.js'

export interface SwitchAction { deviceId: string; functionId: string; on: boolean }
interface Proposal extends SwitchAction { id: string; owner: string; fingerprint: string; approvedAt: string; revision?: string; route: string; expires: number; status: 'pending' | 'running' | 'confirmed' | 'unclear' }
const path = (root: string) => join(root, 'sensing', 'smart-actions.json')
function read(root: string): Proposal[] { try { const v = JSON.parse(readFileSync(path(root), 'utf8')); return Array.isArray(v.actions) ? v.actions : [] } catch { return [] } }
function save(root: string, actions: Proposal[]) { mkdirSync(join(root, 'sensing'), { recursive: true, mode: 0o700 }); atomicWriteJsonSync(path(root), { version: 1, actions: actions.slice(-200) }) }
export function currentSmartFunctions(root: string, d: DeviceRecord, now = Date.now()): DirectFunction[] {
    try {
        const rows: DirectInventory[] = JSON.parse(readFileSync(join(root, 'sensing', 'direct-inventory.json'), 'utf8')).devices
        const r = rows.find(r => r.deviceId === d.id && r.status === 'ok' && r.fingerprint === sensingDeviceFingerprint(d) && r.approvedAt === d.approvedAt && r.accessRevision === nativeAccessRevision(root, d)
            && (r.protocol.endsWith('-cloud') ? 'cloud' : 'local') === approvedSmartRoute(root, d))
        const age = now - Date.parse(r?.at || '')
        return r && age >= 0 && age <= 120_000 && Array.isArray(r.functions) ? r.functions.filter(f => f && f.available !== false).slice(0, 200) : []
    } catch { return [] }
}
export function switchSupported(d: DeviceRecord, f: DirectFunction, route: string): boolean {
    if (!['light', 'switch'].includes(f.kind)) return false
    if (route === 'cloud') return d.hardware?.connector === 'tuya-announcements' && /^(switch_led|switch(?:_\d+)?)$/.test(f.id)
        || d.hardware?.connector === 'shelly-readonly' && /^(switch|light|rgb|rgbw|relays|lights):\d{1,3}$/.test(f.id)
    return d.hardware?.connector === 'hue-readonly' && /^light:\d{1,8}$/.test(f.id)
        || d.hardware?.connector === 'shelly-readonly' && /^(switch|light|rgb|rgbw|relays|lights):\d{1,3}$/.test(f.id)
        || d.hardware?.connector === 'tasmota-readonly' && /^POWER\d{0,3}$/.test(f.id)
        || d.hardware?.connector === 'esphome-native' && /^entity:[a-zA-Z0-9_:.-]{1,80}$/.test(f.id)
        || d.hardware?.connector === 'matter-ip' && /^endpoint:\d{1,5}:type:\d{1,10}$/.test(f.id)
}
export function proposeSmartSwitch(root: string, value: unknown, owner: Approver, now = Date.now()): { ok: boolean; message: string; proposal?: Proposal } {
    const a = value as SwitchAction, d = loadDevices(root).find(d => d.id === a?.deviceId)
    const route = d && approvedSmartRoute(root, d)
    const f = d && currentSmartFunctions(root, d, now).find(f => f.id === a.functionId)
    if (owner.permission !== 'owner' || !owner.principalId || !d || d.approvedBy !== owner.principalId || !route || !f || typeof a.on !== 'boolean' || !switchSupported(d, f, route))
        return { ok: false, message: 'Aktuelle bestätigte Funktion, unterstützter Weg und Owner erforderlich. Keine Aktion vorbereitet.' }
    const proposal: Proposal = { id: randomUUID(), deviceId: d.id, functionId: f.id, on: a.on, owner: owner.principalId, fingerprint: sensingDeviceFingerprint(d), approvedAt: d.approvedAt!, revision: nativeAccessRevision(root, d), route, expires: now + 120_000, status: 'pending' }
    save(root, [...read(root).filter(p => p.status !== 'pending' || p.expires > now), proposal])
    return { ok: true, message: `${d.name} · ${f.name} über ${route === 'local' ? 'lokal' : 'Hersteller-Cloud'} ${a.on ? 'einschalten' : 'ausschalten'}? Physische Wirkung, nur diese Funktion, einmalig. Noch nicht ausgeführt.`, proposal }
}
export async function confirmSmartSwitch(root: string, id: string, owner: Approver, authoritative: () => boolean,
    execute: (d: DeviceRecord, a: SwitchAction, signal: AbortSignal, authorize: () => boolean) => Promise<boolean>, now = Date.now()): Promise<{ ok: boolean; message: string }> {
    const actions = read(root), p = actions.find(p => p.id === id)
    const current = () => loadDevices(root).find(d => d.id === p?.deviceId)
    const authorize = () => {
        const d = current()
        return authoritative() && Date.now() < (p?.expires || 0) && owner.permission === 'owner' && owner.principalId === p?.owner && Boolean(d && d.approvedBy === p.owner && d.approvedAt === p.approvedAt && sensingDeviceFingerprint(d) === p.fingerprint && nativeAccessRevision(root, d) === p.revision && approvedSmartRoute(root, d) === p.route)
    }
    if (!p || p.status !== 'pending' || !Number.isFinite(p.expires) || p.expires <= now || p.expires > now + 120_000 || !authorize()) return { ok: false, message: 'Bestätigung fehlt, ist abgelaufen, schon verbraucht oder die Freigabe wurde geändert.' }
    const d = current()!, f = currentSmartFunctions(root, d, now).find(f => f.id === p.functionId)
    if (!f || !switchSupported(d, f, p.route)) return { ok: false, message: 'Funktion nicht mehr aktuell bestätigt. Keine Aktion.' }
    // Persist before awaiting anything: duplicate requests/crash never retry a write.
    p.status = 'running'; save(root, actions)
    let confirmed = false
    try { confirmed = await execute(d, p, AbortSignal.timeout(20_000), authorize) && authorize() } catch {}
    const latest = read(root), stored = latest.find(v => v.id === id)
    if (stored) { stored.status = confirmed ? 'confirmed' : 'unclear'; save(root, latest) }
    return { ok: confirmed, message: confirmed ? 'Gewünschter Zustand durch Geräte-Rückmeldung bestätigt.' : 'Wirkung nicht bestätigt; Aktion kann bereits erfolgt sein. Kein automatisches Wiederholen. Zustand prüfen.' }
}
