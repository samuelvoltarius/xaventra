/** Direct LAN protocols, independent of HA. Fixed reads only, except explicit
 * owner-approved Hue application registration during a bounded button window. */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { cleanText } from './ports.js'
import { loadDevices, sensingDeviceFingerprint, type DeviceRecord } from './device-registry.js'
import { ownSubnets, scanTargetAllowed, type InterfaceMap } from './net-scope.js'
import { boundedHaJson } from './ha-device-metadata.js'
import { verifyHardwareConnection } from './hardware-recognition.js'
import type { SensingAdapter } from './event-bus.js'
import { approvedSmartRoute } from './smart-device-route.js'
import { readTuyaCloudFunctions } from './tuya-cloud-inventory.js'
import { getTuyaLocalAccess, getEspHomeAccess, getTuyaCloudAccess, getShellyCloudAccess, nativeAccessRevision, getMatterAccess, matterFabricPath } from './smart-device-access.js'
import { readMatterPeer } from './matter-client.js'
import { readShellyCloudFunctions } from './shelly-cloud-inventory.js'
import { readLocalTuya, readLocalEspHome } from './smart-native-client.js'
import { switchSupported } from './smart-control.js'

export interface DirectFunction { id: string; kind: 'light' | 'switch' | 'input' | 'printer' | 'unknown' | 'sensor' | 'binary_sensor' | 'fan' | 'cover' | 'climate' | 'lock' | 'media_player' | 'button' | 'number' | 'select' | 'text'; name: string; manufacturer?: string; model?: string; available?: boolean }
export interface DirectInventory { deviceId: string; fingerprint: string; at: string; protocol: string; approvedAt?: string; accessRevision?: string; status: 'ok' | 'pairing' | 'access-required' | 'unavailable'; functions: DirectFunction[] }
interface PairRequest { fingerprint: string; owner: string; deadline: number; attempts: number; status: 'pending' | 'connected' | 'expired' }
const directory = (root: string) => join(root, 'sensing')
const file = (root: string, name: string) => join(directory(root), name + '.json')
const read = (root: string, name: string): any => { try { const value = JSON.parse(readFileSync(file(root, name), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} } }
const store = (root: string, name: string, data: unknown) => { mkdirSync(directory(root), { recursive: true, mode: 0o700 }); atomicWriteJsonSync(file(root, name), data) }
const text = (v: unknown) => typeof v === 'string' ? cleanText(redactSecrets(v), 80) : ''
const keyFile = (root: string, id: string) => {
    if (!/^dev-[a-f0-9]{10}$/.test(id)) throw new Error('Invalid device ID')
    return join(root, 'secrets', 'smart-devices', id + '.json')
}
export function hueKey(root: string, id: string): string | undefined {
    try { const key = JSON.parse(readFileSync(keyFile(root, id), 'utf8')).hueKey; return typeof key === 'string' && /^[a-zA-Z0-9]{16,80}$/.test(key) ? key : undefined } catch { return undefined }
}

/** Called ONLY by the current owner approval path, never by discovery. */
export function requestHuePairing(root: string, device: DeviceRecord, owner: string, now = Date.now()): void {
    if (device.status !== 'eingerichtet' || device.approvedBy !== owner || device.hardware?.access !== 'hue-pairing-v1' || approvedSmartRoute(root, device) !== 'local') throw new Error('Hue pairing lacks current explicit local approval')
    const requests = read(root, 'smart-pairing')
    requests[device.id] = { fingerprint: sensingDeviceFingerprint(device), owner, deadline: now + 120_000, attempts: 0, status: 'pending' } satisfies PairRequest
    store(root, 'smart-pairing', requests)
}

export function parseDirectFunctions(protocol: string, body: any): DirectFunction[] {
    const result: DirectFunction[] = []
    if (protocol === 'hue') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Hue inventory')
        for (const [id, v] of Object.entries(body).slice(0, 200) as Array<[string, any]>) {
            if (!/^\d{1,8}$/.test(id) || !v || typeof v.modelid !== 'string' || typeof v.type !== 'string' || !v.state || typeof v.state.on !== 'boolean') continue
            result.push({ id: `light:${id}`, kind: 'light', name: text(v.name) || `Hue light ${id}`, model: text(v.modelid), manufacturer: text(v.manufacturername) || undefined,
                ...(typeof v.state.reachable === 'boolean' ? { available: v.state.reachable } : {}) })
        }
    } else if (protocol === 'shelly') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Shelly inventory')
        for (const key of Object.keys(body).slice(0, 200)) {
            const match = /^(switch|light|input|rgb|rgbw):([0-9]{1,3})$/.exec(key)
            if (!match || !body[key] || typeof body[key] !== 'object') continue
            const v = body[key]
            if (v.id !== Number(match[2]) || (match[1] === 'input' ? !(typeof v.state === 'boolean' || v.state === null) : typeof v.output !== 'boolean')) continue
            const kind = match[1] === 'switch' ? 'switch' : match[1] === 'input' ? 'input' : 'light'
            result.push({ id: key, kind, name: `Shelly ${key}`, manufacturer: 'Shelly' })
        }
        // Gen1 channels describe functions, not a verified plug or bulb.
        for (const [key, kind] of [['relays', 'switch'], ['lights', 'light'], ['inputs', 'input']] as const)
            if (Array.isArray(body[key])) body[key].slice(0, 32).forEach((v: unknown, i: number) => { if (v && typeof v === 'object') result.push({ id: `${key}:${i}`, kind, name: `Shelly ${key}:${i}`, manufacturer: 'Shelly' }) })
        if (!result.length && typeof body.sys?.uptime !== 'number' && typeof body.uptime !== 'number') throw new Error('Unconfirmed Shelly status')
    } else if (protocol === 'tasmota') {
        if (!body?.StatusSTS || typeof body.StatusSTS !== 'object') throw new Error('Invalid Tasmota status')
        for (const key of Object.keys(body.StatusSTS).slice(0, 200)) if (/^POWER\d{0,3}$/.test(key) && ['ON', 'OFF'].includes(body.StatusSTS[key]))
            result.push({ id: key, kind: 'switch', name: `Tasmota ${key}` })
        if (!result.length && typeof body.StatusSTS.Time !== 'string') throw new Error('Unconfirmed Tasmota status')
    }
    return result.slice(0, 200)
}

export async function refreshDirectInventory(root: string, signal: AbortSignal, deps: { interfaces?: InterfaceMap; fetch?: typeof fetch; now?: () => number; tuyaRead?: typeof readLocalTuya } = {}): Promise<DirectInventory[]> {
    const now = deps.now || Date.now, fetchFn = deps.fetch || fetch
    const requests: Record<string, PairRequest> = read(root, 'smart-pairing')
    const saved = read(root, 'direct-inventory').devices
    const previous: DirectInventory[] = Array.isArray(saved) ? saved : []
    const results: DirectInventory[] = []
    const devices = loadDevices(root)
    const eligible = devices.filter(d => d.status === 'eingerichtet' && ['hue-readonly', 'shelly-readonly', 'tasmota-readonly', 'tuya-announcements', 'esphome-native', 'matter-ip'].includes(d.hardware?.connector))
    const cursor = read(root, 'direct-cursor').offset
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 && eligible.length ? cursor % eligible.length : 0
    // Bound work per poll without permanently starving devices after the first 8.
    const batch = Array.from({ length: Math.min(8, eligible.length) }, (_, index) => eligible[(offset + index) % eligible.length])
    const pollStarted = Date.now()
    for (const d of batch) {
        if (signal.aborted) return []
        // Leave time to persist completed reads before the sensing bus's 25s
        // abort. Eight slow SDK reads cannot fit in one poll; rotate only work
        // actually attempted, instead of discarding every batch on timeout.
        const reserve = d.hardware?.connector === 'matter-ip' ? 20_000 : ['tuya-announcements', 'esphome-native'].includes(d.hardware?.connector) ? 8_000 : approvedSmartRoute(root, d) === 'cloud' ? 10_000 : 6_000
        if (Date.now() - pollStarted + reserve > 22_000) break
        const protocol = d.hardware!.connector === 'matter-ip' ? 'matter' : d.hardware!.connector === 'hue-readonly' ? 'hue' : d.hardware!.connector === 'shelly-readonly' ? 'shelly' : d.hardware!.connector === 'tuya-announcements' ? 'tuya' : d.hardware!.connector === 'esphome-native' ? 'esphome' : 'tasmota'
        const row: DirectInventory = { deviceId: d.id, fingerprint: sensingDeviceFingerprint(d), at: new Date(now()).toISOString(), protocol, status: 'unavailable', functions: [] }
        row.approvedAt = d.approvedAt
        row.accessRevision = nativeAccessRevision(root, d)
        results.push(row)
        const route = approvedSmartRoute(root, d)
        if (!route) { row.status = 'access-required'; continue }
        const old = previous.find(r => r?.deviceId === d.id && r.fingerprint === row.fingerprint && r.approvedAt === row.approvedAt && r.accessRevision === row.accessRevision && r.protocol === (route === 'cloud' ? protocol + '-cloud' : protocol))
        if (old?.status === 'ok' && Array.isArray(old.functions) && now() - Date.parse(old.at) >= 0 && now() - Date.parse(old.at) < 120_000) { Object.assign(row, old); continue }
        if (route === 'cloud') {
            row.protocol += '-cloud'
            if (!['tuya', 'shelly'].includes(protocol)) { row.status = 'access-required'; continue }
            const access = protocol === 'tuya' ? getTuyaCloudAccess(root, d) : getShellyCloudAccess(root, d)
            // Explicit device-private access; never inherit an unrelated process account.
            if (!access) { row.status = 'access-required'; continue }
            const guardedFetch: typeof fetch = async (url, options) => {
                const current = loadDevices(root).find(v => v.id === d.id)
                if (signal.aborted || !current || sensingDeviceFingerprint(current) !== row.fingerprint || approvedSmartRoute(root, current) !== 'cloud' || current.approvedAt !== row.approvedAt || nativeAccessRevision(root, current) !== row.accessRevision) throw new Error('Cloud consent changed')
                return fetchFn(url, options)
            }
            try {
                row.functions = protocol === 'tuya'
                    ? await readTuyaCloudFunctions(d.hardware!.identity!, signal, { access: access as any, fetch: guardedFetch, now })
                    : await readShellyCloudFunctions(d.hardware!.identity!, access as any, signal, guardedFetch)
                const current = loadDevices(root).find(v => v.id === d.id)
                if (signal.aborted || !current || sensingDeviceFingerprint(current) !== row.fingerprint || current.approvedAt !== row.approvedAt || nativeAccessRevision(root, current) !== row.accessRevision || approvedSmartRoute(root, current) !== 'cloud') { row.functions = []; continue }
                row.status = 'ok'
            } catch { row.functions = []; row.status = 'access-required' }
            continue
        }
        if (protocol === 'matter') {
            const access = getMatterAccess(root, d)
            if (access?.state !== 'connected' || !access.peerId) { row.status = 'access-required'; continue }
            const authorize = () => {
                const current = loadDevices(root).find(v => v.id === d.id)
                return !signal.aborted && Boolean(current && sensingDeviceFingerprint(current) === row.fingerprint && getMatterAccess(root, current)?.revision === access.revision)
            }
            try {
                const result = await readMatterPeer({ host: d.host, port: d.port, identity: d.hardware!.identity!, peerId: access.peerId }, matterFabricPath(root, d, access.revision), signal, authorize, deps.interfaces)
                if (authorize()) { row.functions = result.functions; row.status = 'ok' }
            } catch {}
            continue
        }
        if (protocol === 'esphome') {
            const access = getEspHomeAccess(root, d)
            if (!access) { row.status = 'access-required'; continue }
            try {
                row.functions = await readLocalEspHome({ host: d.host, port: d.port, identity: d.hardware!.identity!, ...access }, signal, deps.interfaces)
                const current = loadDevices(root).find(v => v.id === d.id)
                if (signal.aborted || !current || sensingDeviceFingerprint(current) !== row.fingerprint || !getEspHomeAccess(root, current)) { row.functions = []; continue }
                row.status = 'ok'
            } catch {}
            continue
        }
        if (protocol === 'tuya') {
            const access = getTuyaLocalAccess(root, d)
            if (!access) { row.status = 'access-required'; continue }
            try {
                row.functions = await (deps.tuyaRead || readLocalTuya)({ host: d.host, identity: d.hardware!.identity!, ...access }, signal, deps.interfaces)
                const current = loadDevices(root).find(v => v.id === d.id)
                if (signal.aborted || !current || sensingDeviceFingerprint(current) !== row.fingerprint || !getTuyaLocalAccess(root, current)) { row.functions = []; continue }
                row.status = 'ok'
            } catch { /* No cloud fallback and no false success on authentication failure. */ }
            continue
        }
        if (d.port !== 80 || !scanTargetAllowed(d.host, ownSubnets(deps.interfaces)).allowed) continue
        const base = `http://${d.host}:80`
        const request = async (path: string, method: 'GET' | 'POST' = 'GET') => boundedHaJson(await fetchFn(base + path, { method, redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]), headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify({ devicetype: 'xaventra#read-inventory' }) } : {}) }))
        try {
            // Revalidate identity before sending a key or registration request.
            const verified = await verifyHardwareConnection(d, { interfaces: deps.interfaces, httpProbe: async url => {
                const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) })
                return { status: response.status, body: JSON.stringify(await boundedHaJson(response)) }
            } }, signal)
            if (!verified || signal.aborted) continue
            const current = loadDevices(root).find(v => v.id === d.id)
            if (current?.status !== 'eingerichtet' || sensingDeviceFingerprint(current) !== row.fingerprint || approvedSmartRoute(root, current) !== 'local') continue
            if (protocol === 'hue') {
                let key = hueKey(root, d.id)
                const pair = requests[d.id]
                if (!key && pair?.status === 'pending' && pair.owner === d.approvedBy && pair.fingerprint === row.fingerprint && d.hardware?.access === 'hue-pairing-v1') {
                    if (!Number.isFinite(pair.deadline) || !Number.isInteger(pair.attempts) || pair.attempts < 0 || now() >= pair.deadline || pair.attempts >= 8) { pair.status = 'expired'; store(root, 'smart-pairing', requests) }
                    else {
                        pair.attempts++; store(root, 'smart-pairing', requests)
                        const reply: any = await request('/api', 'POST')
                        const latest = loadDevices(root).find(v => v.id === d.id)
                        if (signal.aborted || !latest || latest.status !== 'eingerichtet' || sensingDeviceFingerprint(latest) !== row.fingerprint || approvedSmartRoute(root, latest) !== 'local') continue
                        if (Array.isArray(reply) && reply.length === 1 && /^[a-zA-Z0-9]{16,80}$/.test(reply[0]?.success?.username || '')) {
                            key = reply[0].success.username
                            const dir = join(root, 'secrets', 'smart-devices'); mkdirSync(dir, { recursive: true, mode: 0o700 }); try { chmodSync(dir, 0o700) } catch {}
                            writeFileSync(keyFile(root, d.id), JSON.stringify({ hueKey: key }), { mode: 0o600 }); try { chmodSync(keyFile(root, d.id), 0o600) } catch {}
                            row.accessRevision = nativeAccessRevision(root, d)
                            pair.status = 'connected'; store(root, 'smart-pairing', requests)
                        } else if (!Array.isArray(reply) || reply[0]?.error?.type !== 101) pair.status = 'expired'
                    }
                }
                if (!key) { row.status = pair?.status === 'pending' ? 'pairing' : 'access-required'; continue }
                row.functions = parseDirectFunctions(protocol, await request(`/api/${key}/lights`))
            } else row.functions = parseDirectFunctions(protocol, await request(protocol === 'shelly' ? d.hardware!.probe === 'shelly-gen1' ? '/status' : '/rpc/Shelly.GetStatus' : '/cm?cmnd=Status%200'))
            if (signal.aborted) return []
            row.status = 'ok'
        } catch { /* A denied/failed read is not proof of absence or control. */ }
    }
    if (!signal.aborted) {
        const retained = previous.filter(r => r && !results.some(next => next.deviceId === r.deviceId)
            && devices.some(d => d.id === r.deviceId && d.status === 'eingerichtet' && sensingDeviceFingerprint(d) === r.fingerprint))
        store(root, 'smart-pairing', requests); store(root, 'direct-inventory', { version: 1, devices: [...results, ...retained].slice(0, 1000) })
        store(root, 'direct-cursor', { offset: eligible.length ? (offset + results.length) % eligible.length : 0 })
    }
    return signal.aborted ? [] : results
}

export function directInventoryAwareness(root: string, now = Date.now()): string {
    const current = loadDevices(root)
    const saved = read(root, 'direct-inventory').devices
    const rows: DirectInventory[] = Array.isArray(saved) ? saved : []
    const lines = ['Direktgeräte ohne Home Assistant (keine Schaltfreigabe):']
    if (rows.length > 8) lines.push(`Auszug: höchstens 8 von ${rows.length} gespeicherten Geräteabfragen; keine vollständige Geräteübersicht.`)
    for (const r of rows.slice(0, 8)) {
        if (!r || typeof r.protocol !== 'string' || !Array.isArray(r.functions) || !current.some(d => d.id === r.deviceId && approvedSmartRoute(root, d) === (r.protocol.endsWith('-cloud') ? 'cloud' : 'local') && sensingDeviceFingerprint(d) === r.fingerprint && d.approvedAt === r.approvedAt && nativeAccessRevision(root, d) === r.accessRevision)
            || !Number.isFinite(Date.parse(r.at)) || now - Date.parse(r.at) < 0 || now - Date.parse(r.at) > 10 * 60_000) continue
        lines.push(`${text(r.deviceId)} · ${text(r.protocol)} · ${text(r.status)}; ${r.status === 'ok' ? r.protocol.endsWith('-cloud') ? 'vom gewählten Hersteller-Cloud-Dienst gelesen' : 'direkt lokal ausgelesen' : 'keine bestätigte Funktionsliste'}`)
        for (const f of r.functions.filter(f => f && typeof f === 'object').slice(0, 24)) lines.push(`${text(f.id)}: ${text(f.kind)} · ${text(f.name)}${f.manufacturer ? ` · Hersteller laut Gerät: ${text(f.manufacturer)}` : ''}${f.model ? ` · Modell: ${text(f.model)}` : ''}; ${f.available === undefined ? 'Erreichbarkeit der Einzelfunktion ungeprüft' : f.available ? 'als erreichbar gemeldet' : 'als nicht erreichbar gemeldet'}`)
        if (r.functions.length > 24) lines.push(`Weitere ${r.functions.length - 24} gemeldete Funktionen dieses Geräts im gespeicherten Inventar; hier gekürzt.`)
    }
    return lines.join('\n').slice(0, 6000)
}

export function createDirectSmartAdapter(root: string): SensingAdapter {
    return { id: 'direct-smart-inventory', source: 'discovery', intervalMs: 15_000, timeoutMs: 25_000, async poll(ctx) {
        const rows = await refreshDirectInventory(root, ctx.signal)
        if (ctx.signal.aborted) return []
        const known = (ctx.state.known || {}) as Record<string, string>
        const events = []
        for (const r of rows) {
            const signature = JSON.stringify([r.fingerprint, r.status, r.functions.map(f => [f.id, f.kind, f.model, f.manufacturer])])
            if (known[r.deviceId] === signature) continue
            known[r.deviceId] = signature
            const d = loadDevices(root).find(d => d.id === r.deviceId)
            const route = d && approvedSmartRoute(root, d)
            const controls = d && route && r.status === 'ok' ? r.functions.filter(f => f.available !== false && switchSupported(d, f, route)).slice(0, 4) : []
            events.push({ kind: 'smart.direct-inventory', subject: r.deviceId, severity: 'info' as const,
                summary: `${r.protocol}: ${r.status === 'ok' ? `${r.functions.length} Funktionen direkt ohne Home Assistant gelesen. Kein Schalten.` : r.status === 'pairing' ? 'Owner-Freigabe liegt vor; bitte jetzt die Hue-Bridge-Taste drücken.' : 'Funktionsbestand nicht bestätigt; Zugang oder erneute Prüfung erforderlich.'}`,
                evidence: { geraet: r.deviceId, protokoll: r.protocol, status: r.status, funktionen: r.functions.length }, hint: { importance: 'normal' as const, level: 'selbst' as const,
                    ...(controls.length ? { proposal: `Direkte Gerätefunktionen verfügbar: ${controls.map(f => `${text(f.name)} (${text(f.id)})`).join(', ')}. Möchtest du eine davon ein- oder ausschalten? Vorbereiten mit /geraete schalten ${r.deviceId} <funktion> ein|aus, danach die konkrete Aktion separat bestätigen. Kein automatisches Schalten.` } : {}) } })
        }
        ctx.state.known = known; return events
    } }
}
