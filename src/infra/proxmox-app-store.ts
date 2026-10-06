/**
 * 2.88 „Proxmox ohne Config“: what the owner entered in the app.
 *
 * - `<data>/connections/proxmox.json`: address, read TLS fingerprint, whether the
 *   owner confirmed it, pool. No secret in here.
 * - The API token lives in the existing secrets file of the connections
 *   (`<data>/secrets/connections/c-proxmox-adapter.json`, 0600 in 0700) — never
 *   in a config file, a log, a card or a thought.
 * Only a CONFIRMED fingerprint makes the adapter usable (loadProxmoxRuntime).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { deleteConnectionSecrets, readConnectionSecrets, updateConnectionSecrets } from '../connections/connection-store.js'

export const PROXMOX_APP_CONNECTION_ID = 'c-proxmox-adapter'
export const PROXMOX_APP_POOL = 'xaventra'
const TOKEN_FIELD = 'XAVENTRA_PVE_TOKEN'

export interface ProxmoxAppSetup {
    version: 1
    /** Origin only, https, e.g. https://192.0.2.10:8006 */
    url: string
    /** SHA-256 of the host certificate as read at setup (AA:BB:…). */
    fingerprint: string
    bestaetigt: boolean
    bestaetigtAt?: string
    pool: string
    savedAt: string
}

export interface AppStoreOptions { dataDir?: string }
const fileOf = (opts: AppStoreOptions) => join(opts.dataDir || getNovaDataDir(), 'connections', 'proxmox.json')
const FP = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/

export function readProxmoxAppSetup(opts: AppStoreOptions = {}): ProxmoxAppSetup | null {
    try {
        const file = fileOf(opts)
        if (!existsSync(file)) return null
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof raw?.url !== 'string' || !/^https:\/\/[^/\s]+$/.test(raw.url) || !FP.test(String(raw.fingerprint || ''))) return null
        return {
            version: 1, url: raw.url, fingerprint: raw.fingerprint, bestaetigt: raw.bestaetigt === true,
            ...(typeof raw.bestaetigtAt === 'string' ? { bestaetigtAt: raw.bestaetigtAt } : {}),
            pool: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(String(raw.pool || '')) ? raw.pool : PROXMOX_APP_POOL, savedAt: String(raw.savedAt || ''),
        }
    } catch { return null }
}

export function writeProxmoxAppSetup(setup: ProxmoxAppSetup, opts: AppStoreOptions = {}): void {
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'connections'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(fileOf(opts), setup)
}

export function readProxmoxAppToken(opts: AppStoreOptions = {}): string | null {
    const value = readConnectionSecrets(PROXMOX_APP_CONNECTION_ID, opts).zugang?.[TOKEN_FIELD]
    return typeof value === 'string' && value ? value : null
}

export function writeProxmoxAppToken(token: string, opts: AppStoreOptions = {}): void {
    updateConnectionSecrets(PROXMOX_APP_CONNECTION_ID, current => ({ ...current, zugang: { ...(current.zugang || {}), [TOKEN_FIELD]: token } }), opts)
}

/** Owner: forget address, fingerprint and token. */
export function clearProxmoxApp(opts: AppStoreOptions = {}): void {
    deleteConnectionSecrets(PROXMOX_APP_CONNECTION_ID, opts)
    try { atomicWriteJsonSync(fileOf(opts), { version: 1, entfernt: true }) } catch { /* nothing stored */ }
}

/** For loadProxmoxRuntime: usable only with a confirmed fingerprint and a stored token. */
export function confirmedProxmoxApp(opts: AppStoreOptions = {}): { url: string; fingerprint: string; pool: string; token: string } | null {
    const setup = readProxmoxAppSetup(opts)
    const token = readProxmoxAppToken(opts)
    return setup?.bestaetigt && token ? { url: setup.url, fingerprint: setup.fingerprint, pool: setup.pool, token } : null
}
