/**
 * Geräte-Datei der Selbst-Erkennung: `<dataDir>/sensing/devices.json`.
 *
 * Bewusst NICHT die Haupt-Config. Ein gefundenes Gerät steht hier mit
 * `status: "gefunden"` und wird von keinem Adapter überwacht. Erst
 * `approveDevice(id, owner)` — aufgerufen von der Knopf-Karte bzw.
 * `/geraete ja <id>` — setzt `eingerichtet`. `disableDevice` schaltet wieder ab.
 * Zugangsdaten (API-Keys, HA-Token) stehen hier nie; sie bleiben ein
 * Owner-Schritt in der Config.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { cleanEvidence, cleanText, type Evidence } from './ports.js'

export type DeviceType = 'moonraker' | 'octoprint' | 'prusalink' | 'bambu' | 'homeassistant'
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

export function monitoredDevices(dataDir: string): DeviceRecord[] {
    return loadDevices(dataDir).filter(item => item.status === 'eingerichtet')
}

export function formatDevices(devices: DeviceRecord[]): string {
    if (!devices.length) return 'Keine Geräte bekannt. /geraete suchen startet eine lesende Suche im eigenen Netz.'
    const icon: Record<DeviceStatus, string> = { gefunden: '🆕', eingerichtet: '✅', abgelehnt: '🚫', aus: '⏸️' }
    return ['Geräte (nur lesend):', ...devices.map(item =>
        `${icon[item.status]} ${item.id} · ${item.name} · ${item.host}:${item.port} · ${item.status} (${item.via})`)].join('\n')
}
