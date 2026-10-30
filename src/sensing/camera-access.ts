/**
 * Kamera anbinden (30.10.2026), Main side. The owner enters the login in the desktop app only
 * (sealed in the vault, never a chat tool). A still is fetched on request: the login goes only to
 * the node that found the camera and only for that address, over the encrypted direct mesh path.
 * The still lands in the private image folder for at most 24 h. No stream, no sound, no retry.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'
import { readSecretJson, writeSecretJson } from '../secrets/local-sealed-store.js'
import { loadDevices, sensingDeviceFingerprint, type Approver, type DeviceRecord } from './device-registry.js'

const MAX_AGE_MS = 24 * 60 * 60_000
const accessFile = (root: string, id: string) => {
    if (!/^dev-[a-f0-9]{10}$/.test(id)) throw new Error('Invalid device ID')
    return join(root, 'secrets', 'kamera', `${id}.json`)
}
const stillDir = () => join(getRuntimeRoot(), '.nova-vision', 'kamera')

export interface CameraAccess { benutzer: string; passwort: string }

export function readCameraAccess(root: string, id: string): CameraAccess | undefined {
    try {
        const value = readSecretJson(accessFile(root, id))
        return typeof value?.benutzer === 'string' && typeof value?.passwort === 'string' ? { benutzer: value.benutzer, passwort: value.passwort } : undefined
    } catch { return undefined }
}

const validLogin = (value: any): value is CameraAccess => typeof value?.benutzer === 'string' && typeof value?.passwort === 'string'
    && /^[\x21-\x7e]{1,64}$/.test(value.benutzer) && value.passwort.length >= 1 && value.passwort.length <= 128 && !/[\u0000-\u001f]/.test(value.passwort)

/** Only from the owner path of the desktop app, only after the owner's Ja for exactly this camera. */
export function submitCameraAccess(root: string, id: string, fingerprint: string, value: unknown, owner: Approver): { ok: boolean; message: string } {
    const device = loadDevices(root).find(item => item.id === id)
    if (owner.permission !== 'owner' || !owner.principalId || !device || device.type !== 'camera' || device.approvedBy !== owner.principalId || sensingDeviceFingerprint(device) !== fingerprint) {
        return { ok: false, message: 'Aktuelle Owner-Freigabe für genau diese Kamera erforderlich.' }
    }
    if (!validLogin(value)) return { ok: false, message: 'Benutzer und Passwort der Kamera erforderlich.' }
    mkdirSync(join(root, 'secrets', 'kamera'), { recursive: true, mode: 0o700 })
    writeSecretJson(accessFile(root, id), { benutzer: value.benutzer, passwort: value.passwort })
    return { ok: true, message: 'Zugang privat gespeichert. Ein Standbild gibt es nur, wenn du danach fragst.' }
}

/** Removes stills older than 24 h; returns how many. */
export function pruneCameraStills(now = Date.now()): number {
    const dir = stillDir()
    if (!existsSync(dir)) return 0
    let removed = 0
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        try {
            const stat = lstatSync(path)
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) { rmSync(path, { force: true }); removed++ }
        } catch { /* already gone */ }
    }
    return removed
}

export interface CameraStillDeps {
    requestNodeKamera: (node: string, payload: any) => Promise<{ base64: string; mimeType: string; capturedAt: string; sha256: string }>
    principalId: string
    runId: string
    localNode: string
}

const onvifRecord = (root: string, device: DeviceRecord): DeviceRecord | undefined =>
    [device, ...loadDevices(root).filter(item => item.type === 'camera' && item.host === device.host)].find(item => item.via === 'udp')

export async function cameraStandbild(root: string, id: string, deps: CameraStillDeps): Promise<{ ok: boolean; message: string; path?: string; capturedAt?: string }> {
    const device = loadDevices(root).find(item => item.id === id && item.type === 'camera')
    if (!device) return { ok: false, message: 'Diese Kamera kenne ich nicht.' }
    const onvif = onvifRecord(root, device)
    if (!onvif) return { ok: false, message: 'Diese Kamera spricht nur RTSP; dieser Weg ist noch nicht gebaut. Nichts versucht.' }
    const access = readCameraAccess(root, onvif.id) || readCameraAccess(root, device.id)
    if (!access) return { ok: false, message: 'Für diese Kamera fehlt noch der Zugang: Benutzer und Passwort gibst nur du in der App unter Verbindungen ein. Ich rate nichts und probiere nichts aus.' }
    // Only the node that found it, only this address. A failed path ends here: no second way.
    const node = onvif.seenBy || deps.localNode
    pruneCameraStills()
    let receipt: Awaited<ReturnType<CameraStillDeps['requestNodeKamera']>>
    try {
        receipt = await deps.requestNodeKamera(node, { operation: 'kamera', principalId: deps.principalId, runId: deps.runId,
            kamera: { host: onvif.host, port: onvif.port }, zugang: { benutzer: access.benutzer, passwort: access.passwort } })
    } catch (error) {
        const known = error instanceof Error && error.name === 'CameraError' ? error.message
            : /Die Kamera [^.]{1,80}\./.exec(error instanceof Error ? error.message : '')?.[0]
        return { ok: false, message: known || `Kein Standbild: ${node} ist gerade nicht direkt und verschlüsselt erreichbar. Nichts anderes versucht.` }
    }
    const dir = stillDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${onvif.id}_${Date.now()}_${randomBytes(6).toString('hex')}.${receipt.mimeType === 'image/png' ? 'png' : 'jpg'}`)
    writeFileSync(path, Buffer.from(receipt.base64, 'base64'), { mode: 0o600, flag: 'wx' })
    return { ok: true, message: 'Ein Standbild geholt. Es bleibt höchstens 24 Stunden privat liegen.', path, capturedAt: receipt.capturedAt }
}
