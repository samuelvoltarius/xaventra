/**
 * Wächter (Phase 7) — `autonomy.watch` settings. Standard AUS; läuft trotzdem,
 * sobald es etwas zu bewachen gibt: eigene Ziele (/monitor, übernommene L19-
 * Ziele) oder die Nachtwache (`autonomy.nightwatch.enabled`). 2.82.0: der
 * Wächter ist die einzige Ziel- und Messlogik.
 *
 *   autonomy.watch.enabled           false
 *   autonomy.watch.intervalMinutes   5      Takt: Messung, Erreichbarkeit, Prognosen
 *   autonomy.watch.retentionDays     30     Aufbewahrung (höchstens 30)
 *   autonomy.watch.maxMegabytes      20     Größengrenze des Messverlaufs
 *   autonomy.watch.failThreshold     3      Fehlschläge in Folge bis zum Alarm
 *   autonomy.watch.mounts            []     zusätzliche Mounts (Standard: System + Daten)
 *   autonomy.watch.targets           []     { name, host, kind: tcp|http|https|ping, port?, path? }
 *   autonomy.watch.tls               []     { name, host, port? }  (Ablauf < tlsWarnDays melden)
 *   autonomy.watch.tlsWarnDays       21
 *   autonomy.watch.backups           []     { name, path, maxAgeHours, pattern? }  (nur mtime)
 *   autonomy.watch.includeDevices    true   eingerichtete Geräte aus /geraete
 *   (Proxmox-Gäste bewacht der Proxmox-Sensing-Adapter, nicht der Wächter — keine Doppel-Alarme)
 *
 * Feste Regeln (Code, nicht Config): nur konfigurierte oder eingerichtete
 * Ziele, keine Portscans, keine Zugangsdaten in Zielen, und nichts, was nach
 * Passwortmanager aussieht (Vaultwarden & Co.), wird übernommen.
 */

export type WatchTargetKind = 'tcp' | 'http' | 'https' | 'ping'
export type WatchTargetOrigin = 'config' | 'geraet' | 'monitor'

export interface WatchTarget {
    id: string
    name: string
    host: string
    kind: WatchTargetKind
    port?: number
    path?: string
    origin: WatchTargetOrigin
}

export interface WatchTlsHost { name: string; host: string; port: number }
export interface WatchBackup { name: string; path: string; maxAgeHours: number; pattern?: string }

export interface WatchSettings {
    enabled: boolean
    intervalMinutes: number
    retentionDays: number
    maxBytes: number
    failThreshold: number
    timeoutMs: number
    mounts: string[]
    targets: WatchTarget[]
    tls: WatchTlsHost[]
    tlsWarnDays: number
    backups: WatchBackup[]
    includeDevices: boolean
    /** Entries dropped by the fixed rules, shown in /waechter (never silently ignored). */
    rejected: string[]
}

export const MAX_RETENTION_DAYS = 30
export const MAX_TARGETS = 64

/** Passwortmanager werden nie übernommen (Alfred 01.10.2026). */
export const PASSWORD_MANAGER_PATTERN = /vault ?warden|bitwarden|passwor|keepass|1password|lastpass|passbolt|psono/i

const HOST_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/
const IPV6_PATTERN = /^[0-9A-Fa-f:]{2,39}$/
const PATH_PATTERN = /^\/[A-Za-z0-9._~\/-]{0,200}$/
const KINDS: readonly WatchTargetKind[] = ['tcp', 'http', 'https', 'ping']
const DEFAULT_PORT: Record<WatchTargetKind, number | undefined> = { tcp: undefined, http: 80, https: 443, ping: undefined }

export function isValidWatchHost(host: unknown): host is string {
    const value = String(host ?? '')
    if (!value || value.includes('@') || value.includes('/')) return false
    return HOST_PATTERN.test(value) || (value.includes(':') && IPV6_PATTERN.test(value))
}

const clean = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
const intIn = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
const portOk = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535

export function watchTargetId(kind: string, host: string, port?: number, path?: string): string {
    return `${kind}:${host}${port ? `:${port}` : ''}${path && path !== '/' ? path : ''}`.toLowerCase().slice(0, 300)
}

/** Validates one target. Returns a reason string when it is refused. */
export function normalizeWatchTarget(raw: any, origin: WatchTargetOrigin): WatchTarget | string {
    const name = clean(raw?.name || raw?.host, 60)
    const kind = String(raw?.kind || '').toLowerCase() as WatchTargetKind
    const host = clean(raw?.host, 253)
    if (PASSWORD_MANAGER_PATTERN.test(`${name} ${host} ${raw?.path ?? ''}`)) return `${name || host}: Passwortmanager wird nie übernommen`
    if (!KINDS.includes(kind)) return `${name || host || '?'}: unbekannte Art ${clean(raw?.kind, 12) || '–'}`
    if (!isValidWatchHost(host)) return `${name || '?'}: ungültiger Host (keine Zugangsdaten, kein Pfad im Host)`
    let port: number | undefined
    if (kind !== 'ping') {
        port = raw?.port === undefined ? DEFAULT_PORT[kind] : raw.port
        if (!portOk(port)) return `${name}: ${kind} braucht genau einen gültigen Port (keine Bereiche)`
    }
    let path: string | undefined
    if (kind === 'http' || kind === 'https') {
        path = raw?.path === undefined ? '/' : String(raw.path)
        if (!PATH_PATTERN.test(path)) return `${name}: ungültiger Pfad (keine Query/Zugangsdaten)`
    }
    return { id: watchTargetId(kind, host, port, path), name: name || host, host, kind, ...(port ? { port } : {}), ...(path ? { path } : {}), origin }
}

export function parseWatchSettings(autonomy: any): WatchSettings {
    const raw = autonomy?.watch ?? {}
    const rejected: string[] = []
    const targets: WatchTarget[] = []
    for (const item of Array.isArray(raw.targets) ? raw.targets.slice(0, MAX_TARGETS) : []) {
        const target = normalizeWatchTarget(item, 'config')
        if (typeof target === 'string') rejected.push(target)
        else if (!targets.some(existing => existing.id === target.id)) targets.push(target)
    }
    const tls: WatchTlsHost[] = []
    for (const item of Array.isArray(raw.tls) ? raw.tls.slice(0, 32) : []) {
        const host = clean(item?.host, 253), name = clean(item?.name || host, 60)
        const port = item?.port === undefined ? 443 : item.port
        if (PASSWORD_MANAGER_PATTERN.test(`${name} ${host}`)) { rejected.push(`${name}: Passwortmanager wird nie übernommen`); continue }
        if (!isValidWatchHost(host) || !portOk(port)) { rejected.push(`${name || '?'}: ungültiger TLS-Host`); continue }
        tls.push({ name, host, port })
    }
    const backups: WatchBackup[] = []
    for (const item of Array.isArray(raw.backups) ? raw.backups.slice(0, 32) : []) {
        const path = clean(item?.path, 400), name = clean(item?.name || path, 60)
        if (PASSWORD_MANAGER_PATTERN.test(`${name} ${path}`)) { rejected.push(`${name}: Passwortmanager wird nie übernommen`); continue }
        if (!path || path.includes('..') || !(Number(item?.maxAgeHours) > 0)) { rejected.push(`${name || '?'}: Backup braucht Pfad und maxAgeHours`); continue }
        const pattern = item?.pattern === undefined ? undefined : clean(item.pattern, 80)
        if (pattern !== undefined && !/^[A-Za-z0-9._*-]{1,80}$/.test(pattern)) { rejected.push(`${name}: ungültiges Muster (nur Buchstaben, Ziffern, . _ - *)`); continue }
        backups.push({ name, path, maxAgeHours: Math.min(24 * 365, Number(item.maxAgeHours)), ...(pattern ? { pattern } : {}) })
    }
    return {
        enabled: raw.enabled === true,
        intervalMinutes: intIn(raw.intervalMinutes, 5, 1, 24 * 60),
        retentionDays: intIn(raw.retentionDays, MAX_RETENTION_DAYS, 1, MAX_RETENTION_DAYS),
        maxBytes: intIn(raw.maxMegabytes, 20, 1, 500) * 1024 * 1024,
        failThreshold: intIn(raw.failThreshold, 3, 1, 20),
        timeoutMs: intIn(raw.timeoutMs, 5000, 500, 30_000),
        mounts: (Array.isArray(raw.mounts) ? raw.mounts : []).map((mount: unknown) => clean(mount, 200)).filter((mount: string) => /^(\/|[A-Za-z]:[\\/])/.test(mount)).slice(0, 8),
        targets, tls,
        tlsWarnDays: intIn(raw.tlsWarnDays, 21, 1, 365),
        backups,
        includeDevices: raw.includeDevices !== false,
        rejected,
    }
}
