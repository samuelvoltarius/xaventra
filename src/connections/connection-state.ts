/**
 * 2.89 Paket B — „Eine Verbindungs-Wahrheit“.
 *
 * ONE answer to „ist X verbunden?“ for every place that asks it (device list,
 * „Verbindungen“, Smart-Geräte page, cards, the connect question, the need
 * rule, learning, awareness). Nobody else decides „verbunden“ on their own.
 *
 *   connectionState(dataDir, ziel) → { zustand, grund }
 *     zustand  'verbunden' — usable now
 *              'wartet'    — begun, one step of the owner is missing (login,
 *                            access value, Hue button, key)
 *              'gefunden'  — not connected (found or merely known)
 *     ziel     { connectorId }  a catalog connector („home-assistant“, „n8n“ …)
 *              { geraet }       a consolidated device (device-consolidation.ts)
 *              { record }       one raw device record → judged as its whole device
 *              { verbindung }   one stored connection record
 *
 * Rules (fixed in code):
 * - Home Assistant: per instance — a connection (or the configured HA of
 *   HASS_URL / xaventra.config.json) counts only for the instance whose
 *   address it carries (haConnectedFor; without an evaluable address only
 *   when exactly one instance exists).
 * - Hue: the pairing key on device level (any member of the device).
 * - Tuya / ESPHome / Matter / Shelly: an approved way AND the stored key on
 *   the same record (Matter only once its access is „connected“).
 * - Printers: set up = their status is read. Catalog services found in the
 *   net (n8n, Paperless …): the state of their connector.
 * - Anything else that is merely „eingerichtet“ (watched) is NOT connected.
 *
 * The configured Home Assistant is migrated once into connections.json
 * (`herkunft: 'konfiguriert'`, migrateConfiguredHomeAssistant, daemon start).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolveConfigPath } from '../config/config-path.js'
import { getNovaDataDir } from '../core/data-root.js'
import { resolveHaConnection } from '../sensing/adapters/homeassistant.js'
import { consolidateDevices, haConnectedFor, readHostAliases, type Geraet } from '../sensing/device-consolidation.js'
import { loadDevices, type DeviceRecord } from '../sensing/device-registry.js'
import { hueKey } from '../sensing/direct-smart-devices.js'
import { getEspHomeAccess, getMatterAccess, getShellyCloudAccess, getTuyaCloudAccess, getTuyaLocalAccess } from '../sensing/smart-device-access.js'
import { approvedSmartRoute, selectedSmartRoute } from '../sensing/smart-device-route.js'
import { connectionIdFor, loadConnections, saveConnection, type ConnectionRecord, type ConnectionStatus } from './connection-store.js'
import { getConnectorCatalog, type ConnectorManifest } from './connector-catalog.js'

export type Verbindungszustand = 'verbunden' | 'wartet' | 'gefunden'
export interface Verbindungsstand { zustand: Verbindungszustand; grund: string }

export type Verbindungsziel =
    | { connectorId: string }
    | { geraet: Pick<Geraet, 'art' | 'adressen' | 'dienste'> }
    | { record: DeviceRecord }
    | { verbindung: ConnectionRecord }

/** What the rules read. Loaded once per call site (or injected: tests, the connections view). */
export interface StandKontext {
    dataDir: string
    connections: ConnectionRecord[]
    devices: DeviceRecord[]
    aliase: Record<string, string>
    /** Address of the configured Home Assistant (never the token); null = none. */
    konfiguriertesHa: string | null
}
export type StandEingabe = Partial<Omit<StandKontext, 'dataDir'>>

const HA_CONNECTOR = 'home-assistant'
export const KEYED_CONNECTORS: ReadonlySet<string> = new Set(['tuya-announcements', 'esphome-native', 'matter-ip', 'shelly-readonly'])
const SMART_CONNECTORS: ReadonlySet<string> = new Set(['hue-readonly', 'tasmota-readonly'])

const STATUS_GRUND: Record<ConnectionStatus, string> = {
    verbunden: 'verbunden', 'wartet-auf-anmeldung': 'Anmeldung fehlt noch', 'wartet-auf-zugang': 'Zugang fehlt noch',
    abgelaufen: 'Anmeldung abgelaufen', fehler: 'letzter Test fehlgeschlagen', getrennt: 'getrennt',
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn() } catch { return fallback } }

/**
 * The configured Home Assistant (the sensing adapter's url + token, HASS_URL/HASS_TOKEN or
 * `homeassistant.url/token` in xaventra.config.json — resolveHaConnection) — the address
 * only, never the token.
 */
export function configuredHomeAssistantUrl(options: { env?: NodeJS.ProcessEnv; config?: unknown } = {}): string | null {
    let config = options.config
    if (config === undefined) {
        try { const path = resolveConfigPath(); config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { config = null }
    }
    const adapter = (config as any)?.autonomy?.sensing?.adapters?.homeassistant
    try { return resolveHaConnection(adapter && typeof adapter === 'object' ? adapter : {}, config, options.env || process.env)?.url || null } catch { return null }
}

/**
 * Loads what the rules read. The configured HA is read only for the runtime's own data
 * directory: a foreign directory (tests, another root) never inherits this process's
 * environment or config file.
 */
export function standKontext(dataDir: string = getNovaDataDir(), over: StandEingabe = {}): StandKontext {
    const own = dataDir === getNovaDataDir()
    return {
        dataDir,
        connections: over.connections ?? safe(() => loadConnections({ dataDir }), []),
        devices: over.devices ?? safe(() => loadDevices(dataDir), []),
        aliase: over.aliase ?? safe(() => readHostAliases(dataDir), {}),
        konfiguriertesHa: over.konfiguriertesHa !== undefined ? over.konfiguriertesHa : own ? configuredHomeAssistantUrl() : null,
    }
}

const asKontext = (dataDir: string, kontext?: StandKontext | StandEingabe): StandKontext =>
    kontext && (kontext as StandKontext).dataDir === dataDir && 'konfiguriertesHa' in kontext && 'devices' in kontext && 'connections' in kontext && 'aliase' in kontext
        ? kontext as StandKontext
        : standKontext(dataDir, (kontext || {}) as StandEingabe)

/** The one question: how far is this connection? Never throws. */
export function connectionState(dataDir: string, ziel: Verbindungsziel, kontext?: StandKontext | StandEingabe): Verbindungsstand {
    try {
        const ctx = asKontext(dataDir, kontext)
        if ('connectorId' in ziel) return connectorState(String(ziel.connectorId || ''), ctx)
        if ('verbindung' in ziel) return recordState(ziel.verbindung, ctx)
        if ('geraet' in ziel) return deviceState(ziel.geraet, membersOf(ziel.geraet, ctx), ctx)
        const geraet = geraeteOf(ctx).find(g => g.dienste.some(d => d.id === ziel.record.id))
        return geraet ? deviceState(geraet, membersOf(geraet, ctx, ziel.record), ctx)
            : deviceState({ art: artOfSingle(ziel.record), adressen: [ziel.record.host], dienste: [] }, [ziel.record], ctx)
    } catch {
        return { zustand: 'gefunden', grund: 'Stand nicht lesbar' }
    }
}

/** Convenience for list filters. */
export const isConnected = (dataDir: string, ziel: Verbindungsziel, kontext?: StandKontext | StandEingabe): boolean =>
    connectionState(dataDir, ziel, kontext).zustand === 'verbunden'

/** Catalog connector ids that are connected now (need rule, learning). */
export function connectedConnectorIds(dataDir: string = getNovaDataDir(), kontext?: StandEingabe): Set<string> {
    const ctx = standKontext(dataDir, kontext || {})
    const ids = new Set<string>([HA_CONNECTOR, ...ctx.connections.map(c => c.connectorId)])
    return new Set([...ids].filter(id => connectorState(id, ctx).zustand === 'verbunden'))
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/** Stored records as they count now: a configured-HA record without the configuration is gone. */
function effective(ctx: StandKontext): ConnectionRecord[] {
    return ctx.connections.map(c => c.herkunft === 'konfiguriert' && !ctx.konfiguriertesHa ? { ...c, status: 'getrennt' as const } : c)
}

/** The configured HA counts unless the owner disconnected Home Assistant. */
function configuredHa(ctx: StandKontext): string | null {
    if (!ctx.konfiguriertesHa) return null
    const own = ctx.connections.find(c => c.id === connectionIdFor(HA_CONNECTOR))
    return own?.status === 'getrennt' ? null : ctx.konfiguriertesHa
}

function recordState(record: ConnectionRecord, ctx: StandKontext): Verbindungsstand {
    if (record.herkunft === 'konfiguriert' && record.status !== 'getrennt') {
        return configuredHa(ctx) ? { zustand: 'verbunden', grund: 'über die Konfiguration' } : { zustand: 'gefunden', grund: 'Konfiguration entfernt' }
    }
    if (record.status === 'verbunden') return { zustand: 'verbunden', grund: record.letzterTest?.ok ? `verbunden, ${record.letzterTest.werkzeuge} Werkzeuge getestet` : 'verbunden' }
    if (record.status === 'getrennt') return { zustand: 'gefunden', grund: 'getrennt' }
    return { zustand: 'wartet', grund: STATUS_GRUND[record.status] || 'wartet' }
}

function connectorState(connectorId: string, ctx: StandKontext): Verbindungsstand {
    if (!connectorId) return { zustand: 'gefunden', grund: 'unbekannt' }
    const records = effective(ctx).filter(c => c.connectorId === connectorId && c.status !== 'getrennt')
    const connected = records.find(c => c.status === 'verbunden')
    if (connected) return recordState(connected, ctx)
    if (connectorId === HA_CONNECTOR && configuredHa(ctx)) return { zustand: 'verbunden', grund: 'über die Konfiguration' }
    if (records.length) return recordState(records[0], ctx)
    return { zustand: 'gefunden', grund: 'nicht verbunden' }
}

let cache: { key: string; geraete: Geraet[] } | null = null
function geraeteOf(ctx: StandKontext): Geraet[] {
    const key = `${ctx.dataDir}|${ctx.devices.map(d => `${d.id}:${d.status}:${d.host}`).join(',')}|${JSON.stringify(ctx.aliase)}`
    if (cache?.key === key) return cache.geraete
    const geraete = consolidateDevices(ctx.devices, { aliase: ctx.aliase }).geraete
    cache = { key, geraete }
    return geraete
}

function membersOf(geraet: Pick<Geraet, 'dienste'>, ctx: StandKontext, fallback?: DeviceRecord): DeviceRecord[] {
    const ids = new Set(geraet.dienste.map(d => d.id))
    const members = ctx.devices.filter(d => ids.has(d.id))
    return members.length ? members : fallback ? [fallback] : []
}

function artOfSingle(record: DeviceRecord): Geraet['art'] {
    return safe(() => consolidateDevices([record], {}).geraete[0]?.art, undefined) || (record.type === 'homeassistant' ? 'homeassistant' : 'geraet')
}

function haState(adressen: readonly string[], ctx: StandKontext): Verbindungsstand {
    const instanzen = geraeteOf(ctx).filter(g => g.art === 'homeassistant').length
    const ha = effective(ctx).filter(c => c.connectorId === HA_CONNECTOR)
    const connected = ha.filter(c => c.status === 'verbunden' && c.herkunft !== 'konfiguriert')
    if (haConnectedFor(connected, adressen, instanzen, ctx.aliase)) return { zustand: 'verbunden', grund: 'bei Home Assistant angemeldet' }
    const config = configuredHa(ctx)
    if (config && haConnectedFor([{ connectorId: HA_CONNECTOR, status: 'verbunden', basis: config }], adressen, instanzen, ctx.aliase)) return { zustand: 'verbunden', grund: 'über die Konfiguration' }
    const waiting = ha.find(c => !['verbunden', 'getrennt'].includes(c.status) && haConnectedFor([{ ...c, status: 'verbunden' }], adressen, instanzen, ctx.aliase))
    if (waiting) return { zustand: 'wartet', grund: STATUS_GRUND[waiting.status] }
    return { zustand: 'gefunden', grund: 'nicht verbunden' }
}

/** A key that makes the way usable (Matter only when its access is connected). */
function hasKey(dataDir: string, record: DeviceRecord): boolean {
    try {
        const matter = getMatterAccess(dataDir, record)
        return Boolean(getTuyaLocalAccess(dataDir, record) || getTuyaCloudAccess(dataDir, record) || getEspHomeAccess(dataDir, record)
            || getShellyCloudAccess(dataDir, record) || (matter && matter.state === 'connected'))
    } catch { return false }
}

const hasHueKey = (dataDir: string, record: DeviceRecord) => Boolean(safe(() => hueKey(dataDir, record.id), undefined))

/** Smart-Geräte page: is a private access value stored for this record (Hue key included, Matter only when connected)? */
export function accessStored(dataDir: string, record: DeviceRecord): boolean {
    return hasHueKey(dataDir, record) || hasKey(dataDir, record)
}

const catalogEntries = (): readonly ConnectorManifest[] => safe(() => getConnectorCatalog().entries, [] as ConnectorManifest[])

function deviceState(geraet: Pick<Geraet, 'art' | 'adressen' | 'dienste'>, members: DeviceRecord[], ctx: StandKontext): Verbindungsstand {
    const dataDir = ctx.dataDir
    if (geraet.art === 'homeassistant' || members.some(r => r.type === 'homeassistant')) {
        return haState(geraet.adressen.length ? geraet.adressen : members.map(r => r.host), ctx)
    }
    if (members.some(r => hasHueKey(dataDir, r))) return { zustand: 'verbunden', grund: 'Hue Bridge gekoppelt' }
    if (geraet.art === 'hue') {
        return members.some(r => r.status === 'eingerichtet') ? { zustand: 'wartet', grund: 'Taste an der Hue Bridge noch nicht gedrückt' } : { zustand: 'gefunden', grund: 'nicht verbunden' }
    }
    const keyed = members.filter(r => KEYED_CONNECTORS.has(String(r.hardware?.connector || '')))
    if (keyed.length) {
        if (keyed.some(r => Boolean(approvedSmartRoute(dataDir, r)) && hasKey(dataDir, r))) return { zustand: 'verbunden', grund: 'Weg freigegeben, Code gespeichert' }
        if (keyed.some(r => Boolean(approvedSmartRoute(dataDir, r)))) return { zustand: 'wartet', grund: geraet.art === 'matter' ? 'Code vom Gerät fehlt noch' : geraet.art === 'tuya' ? 'Code aus der Tuya-App fehlt noch' : 'Zugangscode fehlt noch' }
        if (keyed.some(r => r.status === 'eingerichtet' || Boolean(selectedSmartRoute(dataDir, r)))) return { zustand: 'wartet', grund: 'Weg noch nicht freigegeben' }
        return { zustand: 'gefunden', grund: 'nicht verbunden' }
    }
    const smart = members.filter(r => SMART_CONNECTORS.has(String(r.hardware?.connector || '')))
    if (smart.length) {
        if (smart.some(r => Boolean(approvedSmartRoute(dataDir, r)))) return { zustand: 'verbunden', grund: 'Weg freigegeben' }
        if (smart.some(r => r.status === 'eingerichtet')) return { zustand: 'wartet', grund: 'Weg noch nicht freigegeben' }
        return { zustand: 'gefunden', grund: 'nicht verbunden' }
    }
    // A self-hosted catalog service (n8n, Paperless …): the state of its connector.
    const entries = catalogEntries()
    const connector = members.map(r => entries.find(entry => entry.findet?.geraet === r.type)?.name).find(Boolean)
    if (connector) return connectorState(connector, ctx)
    if (geraet.art === 'drucker') {
        return members.some(r => r.status === 'eingerichtet') ? { zustand: 'verbunden', grund: 'Status wird gelesen' } : { zustand: 'gefunden', grund: 'nicht verbunden' }
    }
    // „eingerichtet“ alone (watched) is no connection.
    return { zustand: 'gefunden', grund: members.some(r => r.status === 'eingerichtet') ? 'nur beobachtet, kein Verbindungsweg' : 'nicht verbunden' }
}

// ---------------------------------------------------------------------------
// one question per thing
// ---------------------------------------------------------------------------

/**
 * 2.89: the ONE dedupe key of every connection question — the device card, the
 * „verbinden?“ card, the need thought and the discovery offer.
 */
export function verbindungsFrageKey(ziel: { connectorId?: string; geraetKey?: string }): string {
    const value = String(ziel.connectorId || ziel.geraetKey || '').trim().slice(0, 180)
    return `verbindung:${value || 'unbekannt'}`
}

/** The question key of a consolidated device: a device a catalog connector serves (Home Assistant) is asked under its connector. */
export function geraetFrageKey(geraet: Pick<Geraet, 'key' | 'art' | 'dienste'>): string {
    if (geraet.art === 'homeassistant') return verbindungsFrageKey({ connectorId: HA_CONNECTOR })
    const entries = catalogEntries()
    const connector = geraet.dienste.map(d => entries.find(entry => entry.findet?.geraet === d.typ)?.name).find(Boolean)
    return verbindungsFrageKey(connector ? { connectorId: connector } : { geraetKey: geraet.key })
}

/** Question key of one raw record: through its consolidated device. */
export function recordFrageKey(dataDir: string, record: DeviceRecord, kontext?: StandEingabe): string {
    const ctx = standKontext(dataDir, kontext || {})
    const geraet = geraeteOf(ctx).find(g => g.dienste.some(d => d.id === record.id))
    return geraet ? geraetFrageKey(geraet) : verbindungsFrageKey({ geraetKey: `rec:${record.id}` })
}

/** Is a question with this key already open — as a card OR as a thought? (never two questions about one thing) */
export async function verbindungsFrageOffen(key: string, options: { dataDir?: string; now?: number } = {}): Promise<boolean> {
    const now = options.now ?? Date.now()
    try {
        const { listApprovalCards } = await import('../core/approval-cards.js')
        const cards = listApprovalCards(options.dataDir ? { dataDir: options.dataDir, ledger: null } : {})
        if (cards.some(card => card.dedupeKey === key && (card.status === 'offen' || card.status === 'spaeter') && Date.parse(card.expiresAt) > now)) return true
    } catch { /* no card store */ }
    try {
        const { getThoughtStore, isOpenThought } = await import('../planner/index.js')
        const signature = createHash('sha256').update(key).digest('hex').slice(0, 16)
        if (getThoughtStore(options.dataDir).list({ limit: 500 }).some(item => item.signature === signature && isOpenThought(item))) return true
    } catch { /* no thought store */ }
    return false
}

// ---------------------------------------------------------------------------
// migration: configured Home Assistant → connections.json
// ---------------------------------------------------------------------------

/**
 * A Home Assistant configured through HASS_URL / xaventra.config.json becomes ONE
 * connections.json entry (`herkunft: 'konfiguriert'`, read over the REST interface
 * with the configured token; the token is never copied). An owner connection already
 * there wins. Idempotent; called at daemon start.
 */
export function migrateConfiguredHomeAssistant(dataDir: string = getNovaDataDir(), url: string | null = configuredHomeAssistantUrl(), now: number = Date.now()): ConnectionRecord | null {
    if (!url) return null
    const id = connectionIdFor(HA_CONNECTOR)
    if (loadConnections({ dataDir }).some(c => c.id === id)) return null
    let basis: string
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return null; basis = `${parsed.protocol}//${parsed.host}` } catch { return null }
    const iso = new Date(now).toISOString()
    return saveConnection({
        id, connectorId: HA_CONNECTOR, trust: 'geprueft', title: 'Home Assistant', kategorie: 'zuhause', datenklasse: 'lokal', auth: 'token',
        transport: { art: 'http', url: `${basis}/api/` }, basis, status: 'verbunden', weg: 'rest', herkunft: 'konfiguriert',
        createdAt: iso, updatedAt: iso, approvedBy: 'konfiguriert', erlaubteWerkzeuge: [],
    }, { dataDir, now: () => now })
}
