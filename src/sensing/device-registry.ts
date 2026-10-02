/**
 * Geräte-Datei der Selbst-Erkennung: `<dataDir>/sensing/devices.json`.
 *
 * Bewusst NICHT die Haupt-Config. P8 „Standard: selbstständig“: Beobachten ist
 * L0. Ein gefundenes Gerät, das sich OHNE Zugangsdaten nur lesend abfragen
 * lässt (Moonraker/Klipper), wird sofort `eingerichtet` (`autoMonitorDevice`,
 * approvedBy `auto:lesend`) — keine Karte. Braucht ein Gerät einen
 * Schlüssel/Token (OctoPrint, PrusaLink, Home Assistant, Bambu), bleibt es
 * `gefunden` und es gibt genau EINE Bitte an den Owner (`ownerAskedAt`).
 * Owner-Entscheidungen (`abgelehnt`, `aus`) werden nie überschrieben;
 * `/geraete ja|nein|aus <id>` bleibt als Einblick/Korrektur.
 * Zugangsdaten (API-Keys, HA-Token) stehen hier nie und werden nie geraten.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { cleanEvidence, cleanText, type Evidence } from './ports.js'

export type DeviceType = 'moonraker' | 'octoprint' | 'prusalink' | 'bambu' | 'homeassistant'
    // 2.85 Paket A: self-hosted services with an MCP connector (found quietly, connected via „Verbindungen“).
    | 'n8n' | 'paperless' | 'immich' | 'jellyfin' | 'nextcloud'
export type DeviceStatus = 'gefunden' | 'eingerichtet' | 'abgelehnt' | 'aus'

export interface DeviceRecord {
    id: string
    type: DeviceType
    name: string
    host: string
    port: number
    via: 'tcp' | 'http' | 'mdns'
    status: DeviceStatus
    foundAt: string
    lastSeenAt: string
    approvedAt?: string
    approvedBy?: string
    /** set once when the owner was asked for an API key/token (never repeated). */
    ownerAskedAt?: string
    evidence: Evidence
}

export interface DeviceCandidate {
    type: DeviceType
    host: string
    port: number
    via: 'tcp' | 'http' | 'mdns'
    name?: string
    evidence?: Record<string, unknown>
}

export interface Approver { principalId: string; permission?: string }

const FILE = (dataDir: string) => join(dataDir, 'sensing', 'devices.json')
export const DEVICE_LABEL: Record<DeviceType, string> = {
    moonraker: 'Drucker (Moonraker/Klipper)',
    octoprint: 'Drucker (OctoPrint)',
    prusalink: 'Drucker (PrusaLink)',
    bambu: 'Drucker (Bambu, nur TCP erkannt)',
    homeassistant: 'Home Assistant',
    n8n: 'n8n (Automationen)',
    paperless: 'Paperless-ngx (Dokumente)',
    immich: 'Immich (Fotos)',
    jellyfin: 'Jellyfin (Medien)',
    nextcloud: 'Nextcloud (Dateien)',
}

export function deviceId(candidate: Pick<DeviceCandidate, 'type' | 'host' | 'port'>): string {
    return `dev-${createHash('sha256').update(`${candidate.type}|${candidate.host}|${candidate.port}`).digest('hex').slice(0, 10)}`
}

export function loadDevices(dataDir: string): DeviceRecord[] {
    try {
        if (!existsSync(FILE(dataDir))) return []
        const raw = JSON.parse(readFileSync(FILE(dataDir), 'utf8'))
        return Array.isArray(raw?.devices) ? raw.devices.filter((item: any) => item && typeof item.id === 'string') : []
    } catch { return [] }
}

function saveDevices(dataDir: string, devices: DeviceRecord[]): void {
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(FILE(dataDir), { version: 1, devices: devices.slice(-200) })
}

/** Records candidates; returns only the ones that are NEW (never seen before). */
export function recordCandidates(dataDir: string, candidates: DeviceCandidate[], nowMs = Date.now()): DeviceRecord[] {
    const devices = loadDevices(dataDir)
    const fresh: DeviceRecord[] = []
    const at = new Date(nowMs).toISOString()
    for (const candidate of candidates) {
        const id = deviceId(candidate)
        const existing = devices.find(item => item.id === id)
        if (existing) { existing.lastSeenAt = at; continue }
        const record: DeviceRecord = {
            id, type: candidate.type,
            name: cleanText(candidate.name || `${DEVICE_LABEL[candidate.type]} ${candidate.host}`, 80),
            host: candidate.host, port: candidate.port, via: candidate.via,
            status: 'gefunden', foundAt: at, lastSeenAt: at,
            evidence: cleanEvidence(candidate.evidence),
        }
        devices.push(record)
        fresh.push(record)
    }
    saveDevices(dataDir, devices)
    return fresh
}

function requireOwner(approver: Approver | undefined): string | null {
    if (!approver || approver.permission !== 'owner' || !String(approver.principalId || '').trim()) return 'Nur der Owner kann Geräte einrichten.'
    return null
}

/** The only way a found device becomes monitored. */
export function approveDevice(dataDir: string, id: string, approver: Approver, nowMs = Date.now()): { ok: boolean; message: string; device?: DeviceRecord } {
    const denied = requireOwner(approver)
    if (denied) return { ok: false, message: denied }
    const devices = loadDevices(dataDir)
    const device = devices.find(item => item.id === id)
    if (!device) return { ok: false, message: `Gerät ${cleanText(id, 40)} unbekannt.` }
    if (device.status === 'eingerichtet') return { ok: true, message: `${device.name} ist bereits eingerichtet.`, device }
    device.status = 'eingerichtet'
    device.approvedAt = new Date(nowMs).toISOString()
    device.approvedBy = cleanText(approver.principalId, 80)
    saveDevices(dataDir, devices)
    return { ok: true, message: `${device.name} wird ab jetzt (nur lesend) überwacht.`, device }
}

export function setDeviceStatus(dataDir: string, id: string, status: 'abgelehnt' | 'aus', approver: Approver): { ok: boolean; message: string } {
    const denied = requireOwner(approver)
    if (denied) return { ok: false, message: denied }
    const devices = loadDevices(dataDir)
    const device = devices.find(item => item.id === id)
    if (!device) return { ok: false, message: `Gerät ${cleanText(id, 40)} unbekannt.` }
    device.status = status
    saveDevices(dataDir, devices)
    return { ok: true, message: status === 'aus' ? `${device.name}: Überwachung aus.` : `${device.name}: abgelehnt, wird nicht mehr vorgeschlagen.` }
}

/**
 * 2.85 Paket A: services that are only listed under „Gefunden“ in „Verbindungen“ —
 * never auto-monitored, never asked about (Bedarfsregel: finding alone never asks).
 */
export const SILENT_SERVICE_TYPES: ReadonlySet<DeviceType> = Object.freeze(new Set<DeviceType>(['n8n', 'paperless', 'immich', 'jellyfin', 'nextcloud'])) as ReadonlySet<DeviceType>

/** Types a read-only adapter can watch without any credential. */
export const AUTO_MONITOR_TYPES: ReadonlySet<DeviceType> = Object.freeze(new Set<DeviceType>(['moonraker'])) as ReadonlySet<DeviceType>

/** What the owner would have to provide once (null = nothing, watched right away). */
export function credentialNeed(type: DeviceType): string | null {
    if (AUTO_MONITOR_TYPES.has(type)) return null
    if (type === 'homeassistant') return 'einen Home-Assistant-Token (tokenEnv in autonomy.sensing.adapters.homeassistant, dazu die Entitäten)'
    if (type === 'bambu') return 'den Zugangscode aus dem Gerät (Bambu)'
    return `den API-Schlüssel (apiKeyEnv im Eintrag unter autonomy.sensing.adapters.printer.devices, Typ ${type})`
}

export interface AutoMonitorResult { monitored: DeviceRecord[]; asked: DeviceRecord[] }

/**
 * P8: found devices are watched right away (L0, read only) — no card. Only
 * devices in status `gefunden` are touched; owner decisions stay. Devices that
 * need a credential get exactly one owner request (returned in `asked` once).
 */
export function autoMonitorDevices(dataDir: string, nowMs = Date.now()): AutoMonitorResult {
    const devices = loadDevices(dataDir)
    const monitored: DeviceRecord[] = []
    const asked: DeviceRecord[] = []
    const at = new Date(nowMs).toISOString()
    for (const device of devices) {
        if (device.status !== 'gefunden') continue
        if (SILENT_SERVICE_TYPES.has(device.type)) continue
        if (AUTO_MONITOR_TYPES.has(device.type)) {
            device.status = 'eingerichtet'
            device.approvedAt = at
            device.approvedBy = 'auto:lesend'
            monitored.push(device)
        } else if (!device.ownerAskedAt) {
            device.ownerAskedAt = at
            asked.push(device)
        }
    }
    if (monitored.length || asked.length) saveDevices(dataDir, devices)
    return { monitored, asked }
}

const ASKS_FILE = (dataDir: string) => join(dataDir, 'sensing', 'owner-asks.json')

/**
 * true exactly once per key (persisted): the one owner request for a login or
 * token. Later calls return false, so the request is never repeated.
 */
export function claimOwnerAsk(dataDir: string, key: string, nowMs = Date.now()): boolean {
    const id = cleanText(key, 120)
    if (!id) return false
    let asks: Record<string, string> = {}
    try { if (existsSync(ASKS_FILE(dataDir))) asks = JSON.parse(readFileSync(ASKS_FILE(dataDir), 'utf8'))?.asks || {} } catch { asks = {} }
    if (asks[id]) return false
    asks[id] = new Date(nowMs).toISOString()
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(ASKS_FILE(dataDir), { version: 1, asks })
    return true
}

export function monitoredDevices(dataDir: string): DeviceRecord[] {
    return loadDevices(dataDir).filter(item => item.status === 'eingerichtet')
}

export function formatDevices(devices: DeviceRecord[]): string {
    if (!devices.length) return 'Keine Geräte bekannt. Die lesende Suche im eigenen Netz läuft von selbst (einmal am Tag); /geraete suchen startet sie sofort.'
    const icon: Record<DeviceStatus, string> = { gefunden: '🆕', eingerichtet: '✅', abgelehnt: '🚫', aus: '⏸️' }
    return ['Geräte (nur lesend):', ...devices.map(item =>
        `${icon[item.status]} ${item.id} · ${item.name} · ${item.host}:${item.port} · ${item.status}${item.approvedBy === 'auto:lesend' ? ' (selbst, lesend)' : ''}${item.status === 'gefunden' && item.ownerAskedAt ? ' (Zugang fehlt)' : ''} (${item.via})`)].join('\n')
}
