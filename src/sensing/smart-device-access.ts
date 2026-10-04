/** Private per-device access, bound to the exact owner-approved route generation. */
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadDevices, sensingDeviceFingerprint, type Approver, type DeviceRecord } from './device-registry.js'
import { approvedSmartRoute } from './smart-device-route.js'

export interface TuyaLocalAccess { key: string; version: '3.1' | '3.3' | '3.4' | '3.5' }
export interface EspHomeAccess { psk: string }
export interface TuyaCloudAccess { client: string; secret: string; region: 'eu' | 'us' | 'cn' | 'in' }
export interface ShellyCloudAccess { host: string; key: string }
export function validShellyCloudHost(host: unknown): host is string {
    // Fixed vendor domain, no URL, credentials, custom port or redirect target.
    return typeof host === 'string' && /^shelly-[1-9][0-9]{0,3}-(?:eu|us|cn|in)\.shelly\.cloud$/.test(host)
}
const path = (root: string, id: string) => {
    if (!/^dev-[a-f0-9]{10}$/.test(id)) throw new Error('Invalid device ID')
    return join(root, 'secrets', 'smart-devices', id + '.json')
}
const read = (root: string, id: string): any => { try { const v = JSON.parse(readFileSync(path(root, id), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
function save(root: string, d: DeviceRecord, field: string, values: object, owner: string): void {
    persist(root, d.id, { ...read(root, d.id), [field]: { ...values, fingerprint: sensingDeviceFingerprint(d), owner, approvedAt: d.approvedAt, revision: randomUUID() } })
}
function persist(root: string, id: string, values: object): void {
    const directory = join(root, 'secrets', 'smart-devices'); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path(root, id) + '.' + randomUUID() + '.tmp'
    try {
        writeFileSync(temporary, JSON.stringify(values), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path(root, id))
    } finally { rmSync(temporary, { force: true }) }
    try { chmodSync(directory, 0o700); chmodSync(path(root, id), 0o600) } catch {}
}
function valid(value: any): value is TuyaLocalAccess {
    return typeof value?.key === 'string' && /^[\x21-\x7e]{16}$/.test(value.key) && ['3.1', '3.3', '3.4', '3.5'].includes(value.version)
}
export function submitTuyaLocalAccess(root: string, id: string, fingerprint: string, value: unknown, owner: Approver): { ok: boolean; message: string } {
    const d = loadDevices(root).find(d => d.id === id)
    if (owner.permission !== 'owner' || !owner.principalId || !d || d.approvedBy !== owner.principalId || approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'tuya-announcements' || sensingDeviceFingerprint(d) !== fingerprint)
        return { ok: false, message: 'Aktuelle Owner-Freigabe für genau dieses lokale Tuya-Gerät erforderlich.' }
    if (!valid(value)) return { ok: false, message: 'Lokaler Schlüssel (16 ASCII-Zeichen) und Protokoll 3.1, 3.3, 3.4 oder 3.5 erforderlich. 3.2 benötigt einen gesonderten, schreibenden Protokollpfad und ist hier nicht freigegeben.' }
    save(root, d, 'tuyaLocal', { key: value.key, version: value.version }, owner.principalId)
    return { ok: true, message: 'Lokaler Zugang privat gespeichert. Der nächste automatische Lauf prüft den tatsächlichen lesenden Gerätezugriff; noch kein Verbindungserfolg und kein Schalten.' }
}
export function submitEspHomeAccess(root: string, id: string, fingerprint: string, value: any, owner: Approver): { ok: boolean; message: string } {
    const d = loadDevices(root).find(d => d.id === id)
    if (owner.permission !== 'owner' || !owner.principalId || !d || d.approvedBy !== owner.principalId || approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'esphome-native' || sensingDeviceFingerprint(d) !== fingerprint)
        return { ok: false, message: 'Aktuelle lokale ESPHome-Owner-Freigabe erforderlich.' }
    if (typeof value?.psk !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.psk) || Buffer.from(value.psk, 'base64').length !== 32) return { ok: false, message: 'ESPHome-API Encryption-Key (32 Byte, Base64) erforderlich.' }
    save(root, d, 'esphome', { psk: value.psk }, owner.principalId)
    return { ok: true, message: 'ESPHome-Zugang privat gespeichert. Automatische verschlüsselte Funktionsabfrage folgt; kein Schalten und noch kein Verbindungserfolg.' }
}
export function getEspHomeAccess(root: string, d: DeviceRecord): EspHomeAccess | undefined {
    if (approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'esphome-native') return
    const v = read(root, d.id).esphome
    if (v?.fingerprint !== sensingDeviceFingerprint(d) || v?.owner !== d.approvedBy || !d.approvedAt || v?.approvedAt !== d.approvedAt || typeof v.psk !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v.psk)) return
    return { psk: v.psk }
}
export function getTuyaLocalAccess(root: string, d: DeviceRecord): TuyaLocalAccess | undefined {
    if (approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'tuya-announcements') return
    const v = read(root, d.id).tuyaLocal
    if (v?.fingerprint !== sensingDeviceFingerprint(d) || v?.owner !== d.approvedBy || !d.approvedAt || v?.approvedAt !== d.approvedAt || !valid(v)) return
    return { key: v.key, version: v.version }
}
export function nativeAccessRevision(root: string, d: DeviceRecord): string | undefined {
    if (d.hardware?.connector === 'hue-readonly' && approvedSmartRoute(root, d) === 'local') {
        const key = read(root, d.id).hueKey
        return typeof key === 'string' && /^[a-zA-Z0-9]{16,80}$/.test(key) ? createHash('sha256').update(key).digest('hex') : undefined
    }
    if (d.hardware?.connector === 'matter-ip') return getMatterAccess(root, d)?.revision
    const field = approvedSmartRoute(root, d) === 'cloud' ? d.hardware?.connector === 'shelly-readonly' ? 'shellyCloud' : 'tuyaCloud' : d.hardware?.connector === 'esphome-native' ? 'esphome' : 'tuyaLocal'
    if (!(getTuyaLocalAccess(root, d) || getEspHomeAccess(root, d) || getTuyaCloudAccess(root, d) || getShellyCloudAccess(root, d))) return
    const revision = read(root, d.id)[field]?.revision
    return typeof revision === 'string' && /^[a-f0-9-]{36}$/.test(revision) ? revision : undefined
}
export interface MatterAccess { revision: string; state: 'pending' | 'running' | 'connected' | 'unclear'; pairingCode?: string; peerId?: string }
export function getMatterAccess(root: string, d: DeviceRecord): MatterAccess | undefined {
    if (approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'matter-ip') return
    const v = read(root, d.id).matter
    if (v?.fingerprint !== sensingDeviceFingerprint(d) || v?.owner !== d.approvedBy || !d.approvedAt || v?.approvedAt !== d.approvedAt || typeof v.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(v.revision) || !['pending', 'running', 'connected', 'unclear'].includes(v.state)) return
    return { revision: v.revision, state: v.state, ...(typeof v.pairingCode === 'string' ? { pairingCode: v.pairingCode } : {}), ...(typeof v.peerId === 'string' ? { peerId: v.peerId } : {}) }
}
export function submitMatterAccess(root: string, id: string, fingerprint: string, value: any, owner: Approver): { ok: boolean; message: string } {
    const d = loadDevices(root).find(d => d.id === id)
    if (!d || owner.permission !== 'owner' || !owner.principalId || d.approvedBy !== owner.principalId || sensingDeviceFingerprint(d) !== fingerprint || approvedSmartRoute(root, d) !== 'local' || d.hardware?.connector !== 'matter-ip') return { ok: false, message: 'Aktuelle lokale Matter-Owner-Freigabe erforderlich.' }
    // A second request after uncertain effects cannot silently add another fabric.
    if (read(root, id).matter) return { ok: false, message: 'Matter-Pairing bereits gestartet oder gespeichert. Kein erneutes Pairing und kein Zurücksetzen; den bestehenden Fabric-Zustand zuerst prüfen.' }
    if (value?.confirmPairing !== 'ja' || typeof value.pairingCode !== 'string' || !/^(?:\d{11}|\d{21})$/.test(value.pairingCode)) return { ok: false, message: 'Separates Pairing-Ja und privater manueller Matter-Code erforderlich. Bei bestehenden Fabrics zuerst die Multi-Admin-Pairing-Funktion am bisherigen Controller öffnen; kein Geräte-Reset.' }
    save(root, d, 'matter', { pairingCode: value.pairingCode, state: 'pending' }, owner.principalId)
    return { ok: true, message: 'Einmaliger Matter-Pairing-Versuch privat freigegeben; kein Schalten und noch kein Verbindungserfolg.' }
}
export function beginMatterAttempt(root: string, d: DeviceRecord): MatterAccess | undefined {
    const access = getMatterAccess(root, d)
    if (!access || access.state !== 'pending') return
    const data = read(root, d.id); data.matter.state = 'running'
    persist(root, d.id, data)
    return { ...access, state: 'running' }
}
export function finishMatterAttempt(root: string, d: DeviceRecord, revision: string, peerId?: string): void {
    const data = read(root, d.id)
    if (data.matter?.revision !== revision || data.matter.state !== 'running') return
    delete data.matter.pairingCode
    data.matter.state = typeof peerId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(peerId) ? 'connected' : 'unclear'
    if (data.matter.state === 'connected') data.matter.peerId = peerId
    persist(root, d.id, data)
}
export function matterFabricPath(root: string, d: DeviceRecord, revision: string): string {
    if (!/^dev-[a-f0-9]{10}$/.test(d.id) || !/^[a-f0-9-]{36}$/.test(revision)) throw new Error('Invalid private Matter path')
    return join(root, 'secrets', 'matter-fabrics', d.id, revision)
}
function cloudStored(root: string, d: DeviceRecord, field: string, connector: string): any {
    if (approvedSmartRoute(root, d) !== 'cloud' || d.hardware?.connector !== connector) return
    const v = read(root, d.id)[field]
    if (v?.fingerprint !== sensingDeviceFingerprint(d) || v?.owner !== d.approvedBy || !d.approvedAt || v?.approvedAt !== d.approvedAt) return
    return v
}
export function getTuyaCloudAccess(root: string, d: DeviceRecord): TuyaCloudAccess | undefined {
    const v = cloudStored(root, d, 'tuyaCloud', 'tuya-announcements')
    if (v && typeof v.client === 'string' && typeof v.secret === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(v.client) && /^[a-zA-Z0-9_-]{8,256}$/.test(v.secret) && ['eu', 'us', 'cn', 'in'].includes(v.region)) return { client: v.client, secret: v.secret, region: v.region }
}
export function getShellyCloudAccess(root: string, d: DeviceRecord): ShellyCloudAccess | undefined {
    const v = cloudStored(root, d, 'shellyCloud', 'shelly-readonly')
    if (v && validShellyCloudHost(v.host) && typeof v.key === 'string' && /^[a-zA-Z0-9_-]{8,512}$/.test(v.key)) return { host: v.host, key: v.key }
}
export function submitSmartCloudAccess(root: string, id: string, fingerprint: string, value: any, owner: Approver): { ok: boolean; message: string } {
    const d = loadDevices(root).find(d => d.id === id)
    if (!d || owner.permission !== 'owner' || !owner.principalId || d.approvedBy !== owner.principalId || approvedSmartRoute(root, d) !== 'cloud' || sensingDeviceFingerprint(d) !== fingerprint)
        return { ok: false, message: 'Aktuelle gerätegebundene Owner-Cloud-Freigabe erforderlich.' }
    if (d.hardware?.connector === 'tuya-announcements' && value && typeof value.client === 'string' && typeof value.secret === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value.client) && /^[a-zA-Z0-9_-]{8,256}$/.test(value.secret) && ['eu', 'us', 'cn', 'in'].includes(value.region))
        save(root, d, 'tuyaCloud', { client: value.client, secret: value.secret, region: value.region }, owner.principalId)
    else if (d.hardware?.connector === 'shelly-readonly' && value && validShellyCloudHost(value.host) && typeof value.key === 'string' && /^[a-zA-Z0-9_-]{8,512}$/.test(value.key))
        save(root, d, 'shellyCloud', { host: value.host, key: value.key }, owner.principalId)
    else return { ok: false, message: 'Gültiger privater Herstellerzugang und unterstützter Hersteller erforderlich. Keine freie Cloud-URL zulässig.' }
    return { ok: true, message: 'Herstellerzugang privat gespeichert. Automatische Abfrage nur dieses freigegebenen Geräts folgt; noch kein Verbindungserfolg und kein Schalten.' }
}
