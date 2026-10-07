/**
 * 2.85 Paket A — Verbindungen: the one store for connector configuration.
 *
 * - `<data>/connections/connections.json`: what is connected, how, with which
 *   rights and status. No secrets in here, ever. The ONLY writer is the connect
 *   flow after the owner's "Ja" on the "Verbinden" card (connect-flow.ts) and
 *   the owner's own actions (Trennen, one tool allowed). The MCP runtime reads it
 *   next to `mcp.servers` of the main config — nobody edits JSON by hand.
 * - `<data>/secrets/connections/<id>.json` (dir 0700, file 0600): OAuth tokens,
 *   client information, PKCE verifier, Home Assistant tokens, owner-entered
 *   access values. Read only by connector-login.ts / the runtime; never logged,
 *   never put into memos, thoughts, cards or chat.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { ConnectorCapability, ConnectorKategorie, Datenklasse } from './connector-catalog.js'

export type ConnectionStatus = 'wartet-auf-anmeldung' | 'wartet-auf-zugang' | 'verbunden' | 'abgelaufen' | 'fehler' | 'getrennt'
export type ConnectionTransport = { art: 'http'; url: string } | { art: 'stdio'; command: 'npx' | 'uvx'; args: string[]; env?: Record<string, string> }

export interface ConnectionTestResult { ok: boolean; at: string; werkzeuge: number; lesend: number; fragend: number; gesperrt: number; fehler?: string }

export interface ConnectionRecord {
    id: string
    connectorId: string
    trust: 'geprueft' | 'community'
    title: string
    kategorie: ConnectorKategorie | 'weitere'
    datenklasse: Datenklasse
    auth: 'oauth' | 'ha-login' | 'token' | 'keiner'
    transport: ConnectionTransport
    status: ConnectionStatus
    createdAt: string
    updatedAt: string
    approvedBy: string
    /** Local base address (Home Assistant) — from discovery or the owner, never from a model. */
    basis?: string
    /** Community: non-reading tools the owner allowed one by one. */
    erlaubteWerkzeuge: string[]
    capabilities?: Record<string, ConnectorCapability>
    standard?: ConnectorCapability
    letzterTest?: ConnectionTestResult
    /** Set once when the owner was asked to log in again (exactly one request per expiry). */
    loginAskedAt?: string
    /**
     * 2.86.1: how the connection is used. `rest` = Home Assistant without its MCP
     * server integration (POST /api/mcp → 404): the same login reads through the
     * normal HA interface (inventory, hass_* tools); switching stays behind a card.
     */
    weg?: 'mcp' | 'rest'
    /** 2.88: directory connections — the version the owner approved (pinned). */
    version?: string
    /** 2.88: Xaventra's own check of a directory entry (registry-vetting.ts); `unbekannt` = every tool asks. */
    pruefung?: 'community' | 'unbekannt'
    /** 2.88: the directory lists a newer version than the approved one (set once; cleared by connecting again). */
    versionNeu?: string
    /**
     * 2.89: migrated from the configuration (HASS_URL / xaventra.config.json): counts only
     * while that configuration exists (connection-state.ts); the token stays there.
     */
    herkunft?: 'konfiguriert'
}

export interface StoreOptions { dataDir?: string; now?: () => number }
const dataDirOf = (opts: StoreOptions) => opts.dataDir || getNovaDataDir()
const file = (opts: StoreOptions) => join(dataDirOf(opts), 'connections', 'connections.json')
const secretsDir = (opts: StoreOptions) => join(dataDirOf(opts), 'secrets', 'connections')
const ID = /^c-[a-z0-9][a-z0-9-]{1,60}$/

export function connectionIdFor(connectorId: string): string {
    const slug = String(connectorId || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
    return `c-${slug || randomBytes(4).toString('hex')}`
}
export function isConnectionId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }

export function loadConnections(opts: StoreOptions = {}): ConnectionRecord[] {
    try {
        if (!existsSync(file(opts))) return []
        const raw = JSON.parse(readFileSync(file(opts), 'utf8'))
        return (Array.isArray(raw?.connections) ? raw.connections : []).filter((item: any) => item && isConnectionId(item.id) && typeof item.connectorId === 'string')
            .map((item: any) => ({ ...item, erlaubteWerkzeuge: Array.isArray(item.erlaubteWerkzeuge) ? item.erlaubteWerkzeuge.filter((tool: unknown) => typeof tool === 'string') : [] }))
    } catch { return [] }
}

export function getConnection(id: string, opts: StoreOptions = {}): ConnectionRecord | undefined {
    return isConnectionId(id) ? loadConnections(opts).find(item => item.id === id) : undefined
}

export function saveConnection(record: ConnectionRecord, opts: StoreOptions = {}): ConnectionRecord {
    if (!isConnectionId(record.id)) throw new Error('Ungültige Verbindungs-ID')
    const all = loadConnections(opts).filter(item => item.id !== record.id)
    const next = { ...record, updatedAt: new Date((opts.now || Date.now)()).toISOString() }
    mkdirSync(join(dataDirOf(opts), 'connections'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(opts), { version: 1, connections: [...all, next].slice(-200) })
    return next
}

export function updateConnection(id: string, patch: Partial<ConnectionRecord>, opts: StoreOptions = {}): ConnectionRecord | undefined {
    const current = getConnection(id, opts)
    if (!current) return undefined
    return saveConnection({ ...current, ...patch, id: current.id }, opts)
}

// ---------------------------------------------------------------------------
// Secrets (0600)
// ---------------------------------------------------------------------------

export interface ConnectionSecrets {
    /** SDK OAuth state (client information, tokens, verifier, discovery). */
    oauth?: { client?: Record<string, unknown>; tokens?: Record<string, unknown>; verifier?: string; discovery?: Record<string, unknown> }
    /** Home Assistant login. */
    ha?: { accessToken: string; refreshToken?: string; expiresAt: number; clientId: string }
    /** Owner-entered access values (token connectors), by env name. */
    zugang?: Record<string, string>
    /** 2.88: secret fields that come from the password vault (credential id by env name; the value never lands here). */
    zugangRef?: Record<string, string>
}

const secretFile = (id: string, opts: StoreOptions) => {
    if (!isConnectionId(id)) throw new Error('Ungültige Verbindungs-ID')
    return join(secretsDir(opts), `${id}.json`)
}

export function readConnectionSecrets(id: string, opts: StoreOptions = {}): ConnectionSecrets {
    try {
        const path = secretFile(id, opts)
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) || {} : {}
    } catch { return {} }
}

/** Writes 0600 into a 0700 directory (write to a temp file, chmod, rename). */
export function writeConnectionSecrets(id: string, secrets: ConnectionSecrets, opts: StoreOptions = {}): void {
    const dir = secretsDir(opts)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch { /* not supported on this filesystem */ }
    const path = secretFile(id, opts)
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* not supported on this filesystem */ }
    renameSync(tmp, path)
}

export function updateConnectionSecrets(id: string, patch: (current: ConnectionSecrets) => ConnectionSecrets, opts: StoreOptions = {}): ConnectionSecrets {
    const next = patch(readConnectionSecrets(id, opts))
    writeConnectionSecrets(id, next, opts)
    return next
}

export function deleteConnectionSecrets(id: string, opts: StoreOptions = {}): void {
    try { rmSync(secretFile(id, opts), { force: true }) } catch { /* nothing stored */ }
}

export function connectionSecretsPath(id: string, opts: StoreOptions = {}): string { return secretFile(id, opts) }
