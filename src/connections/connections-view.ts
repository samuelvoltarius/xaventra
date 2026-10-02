/**
 * 2.85 Paket A, Punkt 6 — „Verbindungen“: one read model for the desktop view,
 * Telegram and the first start (Paket B).
 *
 *   Gefunden  — what Xaventra discovered herself: devices of the self-discovery
 *               (src/sensing, e.g. Home Assistant 8123, printers), own accounts
 *               (src/sensing/accounts.ts: Gmail/Kalender), plus registered
 *               sources (`registerConnectionSource`, e.g. Paket C: local models,
 *               SearXNG). Shown quietly — finding alone never asks.
 *   Möglich   — the whole checked catalog grouped by category (lokal/Cloud,
 *               logo, geprüft) plus the size of the community directory
 *               (nicht geprüft, searchable).
 *   Verbunden — status, what it may do (reads alone / asks for … / never),
 *               last test, Trennen.
 *
 * `listConnections()` is the small interface for Paket B (Erster Start): a
 * flat list with `status` gefunden | moeglich | verbunden.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import {
    getConnectorCatalog, KATEGORIE_LABEL, resolveConnectorIcon, type ConnectorCapability, type ConnectorKategorie, type ConnectorManifest,
} from './connector-catalog.js'
import { loadConnections, type ConnectionRecord, type ConnectionStatus } from './connection-store.js'
import { readDirectoryCache, searchDirectory, type CommunityEntry } from './registry-directory.js'
import { cachedIcon } from './icon-cache.js'
import { needsOwnerOAuthClient, oauthClientFor } from './connector-login.js'

export type ViewKategorie = ConnectorKategorie | 'ki-modelle' | 'hilfsdienste' | 'geraete' | 'weitere'
export const VIEW_KATEGORIE_LABEL: Readonly<Record<ViewKategorie, string>> = Object.freeze({
    ...KATEGORIE_LABEL, 'ki-modelle': 'KI-Modelle', hilfsdienste: 'Suche/Hilfsdienste', geraete: 'Geräte', weitere: 'Weitere',
})

export interface FoundItem {
    id: string
    title: string
    kategorie: ViewKategorie
    /** Short effect ("kann dann Lichter schalten") or what was found. */
    wirkung: string
    /** Where it was found, without secrets ("im Netz 192.168.1.10:8123", "eigenes Konto g…@gmail.com"). */
    fund: string
    /** Catalog connector to connect it with (none = shown only). */
    connectorId?: string
    datenklasse?: 'lokal' | 'cloud'
    icon?: string | null
    verbunden: boolean
}
export interface PossibleItem {
    connectorId: string
    title: string
    wirkung: string
    datenklasse: 'lokal' | 'cloud'
    auth: ConnectorManifest['auth_typ']
    trust: 'geprueft'
    icon: string | null
    status: 'moeglich' | 'verbunden' | 'wartet'
    /** Owner step needed before a login is possible (e.g. own OAuth client at Google). */
    hinweis?: string
}
export interface ConnectedItem {
    id: string
    connectorId: string
    title: string
    status: ConnectionStatus
    trust: 'geprueft' | 'community'
    datenklasse: 'lokal' | 'cloud'
    darf: { lesen: string[]; fragt: string[]; nie: string[]; sonst: string }
    letzterTest?: ConnectionRecord['letzterTest']
    icon: string | null
    aktion: 'anmelden' | 'zugang' | 'keine'
    /** token connectors: the fields the owner enters once (names only, never values). */
    felder?: Array<{ env: string; label: string; geheim: boolean }>
}
export interface ConnectionsOverview {
    gefunden: FoundItem[]
    moeglich: { gruppen: Array<{ kategorie: ConnectorKategorie; label: string; eintraege: PossibleItem[] }>; verzeichnis: { anzahl: number; stand: string | null; vollstaendig: boolean } }
    verbunden: ConnectedItem[]
    stand: string
}

/** Dock for other packages (Paket C: KI-Modelle, Suche/Hilfsdienste). They scan; this view only shows. */
export interface ConnectionSource { id: string; list(): Promise<FoundItem[]> | FoundItem[] }
const sources = new Map<string, ConnectionSource>()
export function registerConnectionSource(source: ConnectionSource): void {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(String(source?.id || '')) || typeof source.list !== 'function') throw new Error('Ungültige Verbindungs-Quelle')
    sources.set(source.id, source)
}
export function unregisterConnectionSource(id: string): void { sources.delete(id) }

export interface ViewDeps {
    dataDir?: string
    devices?: () => Array<{ type: string; host: string; port: number; status?: string; name?: string }>
    accounts?: () => Array<{ kind: 'gmail' | 'imap' | 'google-calendar'; label: string }>
    connections?: () => ConnectionRecord[]
    directoryCachePath?: string
    env?: NodeJS.ProcessEnv
    config?: any
    now?: () => number
}

const DEVICE_TITLE: Record<string, { title: string; wirkung: string; kategorie: ViewKategorie }> = {
    homeassistant: { title: 'Home Assistant', wirkung: 'kann dann Lichter, Steckdosen und Geräte schalten und den Zustand lesen', kategorie: 'zuhause' },
    moonraker: { title: 'Drucker (Klipper)', wirkung: 'wird über „Geräte“ lesend überwacht', kategorie: 'geraete' },
    octoprint: { title: 'Drucker (OctoPrint)', wirkung: 'wird über „Geräte“ lesend überwacht', kategorie: 'geraete' },
    prusalink: { title: 'Drucker (PrusaLink)', wirkung: 'wird über „Geräte“ lesend überwacht', kategorie: 'geraete' },
    bambu: { title: 'Drucker (Bambu)', wirkung: 'wird über „Geräte“ gemerkt', kategorie: 'geraete' },
}

function defaultDevices(dataDir: string) {
    try {
        const file = join(dataDir, 'sensing', 'devices.json')
        const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
        return Array.isArray(raw?.devices) ? raw.devices : []
    } catch { return [] }
}
async function defaultAccounts(dataDir: string): Promise<Array<{ kind: 'gmail' | 'imap' | 'google-calendar'; label: string }>> {
    try {
        // Own auth store only, reduced to non-secret fields right away (sensing/accounts.ts).
        const { readAuthProfileShapes } = await import('../sensing/accounts.js')
        const { maskEmail } = await import('../sensing/accounts.js')
        const out: Array<{ kind: 'gmail' | 'google-calendar'; label: string }> = []
        for (const [name, shape] of Object.entries(readAuthProfileShapes(dataDir))) {
            if (['google', 'gmail', 'google-gmail'].includes(shape.provider)) out.push({ kind: 'gmail', label: maskEmail(shape.email || name) })
            else if (['google-calendar', 'gcal', 'calendar'].includes(shape.provider)) out.push({ kind: 'google-calendar', label: maskEmail(shape.email || name) })
        }
        return out
    } catch { return [] }
}

function darfText(record: ConnectionRecord, manifest?: ConnectorManifest): ConnectedItem['darf'] {
    const caps = record.capabilities || manifest?.capabilities || {}
    const by = (wanted: ConnectorCapability[]) => Object.entries(caps).filter(([, cap]) => wanted.includes(cap)).map(([tool]) => tool).slice(0, 20)
    return {
        lesen: by(['lesen']),
        fragt: [...by(['schreiben', 'senden', 'schalten']), ...(record.trust === 'community' ? record.erlaubteWerkzeuge : [])],
        nie: by(['loeschen']),
        sonst: record.trust === 'community'
            ? 'Nicht geprüft: nur lesende Werkzeuge; andere erst, wenn du sie einzeln erlaubst — und dann fragt jeder Aufruf.'
            : `Unbekannte Werkzeuge fragen dich; ${record.datenklasse === 'cloud' ? 'Privates geht nie in die Cloud.' : 'bleibt lokal.'}`,
    }
}

function hinweisFor(manifest: ConnectorManifest, deps: ViewDeps): string | undefined {
    if (manifest.auth_typ === 'oauth' && needsOwnerOAuthClient(manifest.name) && !oauthClientFor(manifest.name, deps.env, deps.config)) {
        return manifest.name === 'github'
            ? 'Vorher einmal eine GitHub-OAuth-App anlegen (Owner) und ihre Client-ID eintragen.'
            : 'Vorher einmal einen Google-OAuth-Client anlegen (Owner) und seine Client-ID eintragen.'
    }
    if (manifest.auth_typ === 'token') return 'Beim Verbinden einmal Adresse und API-Token eintragen.'
    return undefined
}

export async function collectConnections(deps: ViewDeps = {}): Promise<ConnectionsOverview> {
    const dataDir = deps.dataDir || getNovaDataDir()
    const catalog = getConnectorCatalog()
    const connections = (deps.connections || (() => loadConnections({ dataDir })))().filter(record => record.status !== 'getrennt')
    const connectedIds = new Set(connections.filter(record => record.status === 'verbunden').map(record => record.connectorId))
    const pendingIds = new Set(connections.filter(record => record.status !== 'verbunden').map(record => record.connectorId))
    const manifestOf = (id: string) => catalog.entries.find(entry => entry.name === id)

    const gefunden: FoundItem[] = []
    for (const device of (deps.devices || (() => defaultDevices(dataDir)))()) {
        const known = DEVICE_TITLE[String(device?.type)]
        if (!known || device.status === 'abgelehnt' || typeof device.host !== 'string') continue
        const connectorId = device.type === 'homeassistant' ? 'home-assistant' : undefined
        gefunden.push({
            id: `geraet:${device.type}:${device.host}:${device.port}`, title: known.title, kategorie: known.kategorie, wirkung: known.wirkung,
            fund: `im Netz ${device.host}:${device.port}`, ...(connectorId ? { connectorId, datenklasse: 'lokal' as const, icon: resolveConnectorIcon(manifestOf(connectorId)!) } : {}),
            verbunden: connectorId ? connectedIds.has(connectorId) : device.status === 'eingerichtet',
        })
    }
    for (const account of deps.accounts ? deps.accounts() : await defaultAccounts(dataDir)) {
        const connectorId = account.kind === 'gmail' ? 'gmail' : account.kind === 'google-calendar' ? 'google-calendar' : undefined
        const manifest = connectorId ? manifestOf(connectorId) : undefined
        gefunden.push({
            id: `konto:${account.kind}:${account.label}`, title: manifest?.title || 'E-Mail-Konto', kategorie: manifest?.kategorie || 'kommunikation',
            wirkung: manifest?.wirkung || 'wird vom Mail-Sensor lesend genutzt', fund: `eigenes Konto ${account.label}`,
            ...(manifest ? { connectorId: manifest.name, datenklasse: manifest.datenklasse, icon: resolveConnectorIcon(manifest) } : {}),
            verbunden: connectorId ? connectedIds.has(connectorId) : false,
        })
    }
    for (const source of sources.values()) {
        try {
            for (const item of (await source.list()).slice(0, 50)) {
                if (!item || typeof item.title !== 'string') continue
                gefunden.push({ ...item, id: `${source.id}:${String(item.id).slice(0, 120)}`, title: item.title.slice(0, 80), wirkung: String(item.wirkung || '').slice(0, 160), fund: String(item.fund || '').slice(0, 120) })
            }
        } catch { /* a broken source shows nothing, never breaks the view */ }
    }

    const gruppen = (Object.keys(KATEGORIE_LABEL) as ConnectorKategorie[]).map(kategorie => ({
        kategorie, label: KATEGORIE_LABEL[kategorie],
        eintraege: catalog.entries.filter(entry => entry.kategorie === kategorie).map(entry => ({
            connectorId: entry.name, title: entry.title, wirkung: entry.wirkung, datenklasse: entry.datenklasse, auth: entry.auth_typ, trust: 'geprueft' as const,
            icon: resolveConnectorIcon(entry), status: connectedIds.has(entry.name) ? 'verbunden' as const : pendingIds.has(entry.name) ? 'wartet' as const : 'moeglich' as const,
            ...(hinweisFor(entry, deps) ? { hinweis: hinweisFor(entry, deps) } : {}),
        })),
    })).filter(group => group.eintraege.length)
    const cache = readDirectoryCache(deps.directoryCachePath)

    const verbunden: ConnectedItem[] = connections.map(record => {
        const manifest = record.trust === 'geprueft' ? manifestOf(record.connectorId) : undefined
        return {
            id: record.id, connectorId: record.connectorId, title: record.title, status: record.status, trust: record.trust, datenklasse: record.datenklasse,
            darf: darfText(record, manifest), ...(record.letzterTest ? { letzterTest: record.letzterTest } : {}),
            icon: manifest ? resolveConnectorIcon(manifest) : null,
            ...(record.auth === 'token' && manifest?.zugang ? { felder: manifest.zugang.map(field => ({ ...field })) } : {}),
            aktion: record.status === 'wartet-auf-zugang' ? 'zugang' : ['wartet-auf-anmeldung', 'abgelaufen'].includes(record.status) && record.auth !== 'keiner' ? 'anmelden' : 'keine',
        }
    })
    return {
        gefunden, verbunden,
        moeglich: { gruppen, verzeichnis: { anzahl: cache.entries.length, stand: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null, vollstaendig: cache.complete } },
        stand: new Date((deps.now || Date.now)()).toISOString(),
    }
}

/** Paket B (Erster Start): flat list, status gefunden | moeglich | verbunden. */
export interface ConnectionEntry { id: string; title: string; status: 'gefunden' | 'moeglich' | 'verbunden'; kategorie: string; datenklasse?: 'lokal' | 'cloud'; connectorId?: string; wirkung: string }
export async function listConnections(deps: ViewDeps = {}): Promise<ConnectionEntry[]> {
    const view = await collectConnections(deps)
    const found = view.gefunden.filter(item => !item.verbunden).map(item => ({ id: item.id, title: item.title, status: 'gefunden' as const, kategorie: item.kategorie, datenklasse: item.datenklasse, connectorId: item.connectorId, wirkung: item.wirkung }))
    const connected = view.verbunden.filter(item => item.status === 'verbunden').map(item => ({ id: item.id, title: item.title, status: 'verbunden' as const, kategorie: 'verbunden', datenklasse: item.datenklasse, connectorId: item.connectorId, wirkung: '' }))
    const possible = view.moeglich.gruppen.flatMap(group => group.eintraege.filter(item => item.status === 'moeglich').map(item => ({ id: `katalog:${item.connectorId}`, title: item.title, status: 'moeglich' as const, kategorie: group.kategorie, datenklasse: item.datenklasse, connectorId: item.connectorId, wirkung: item.wirkung })))
    return [...found, ...connected, ...possible]
}

/** Connector ids found on the network / in own accounts (evidence for the need rule). */
export async function foundConnectorIds(deps: ViewDeps = {}): Promise<string[]> {
    const view = await collectConnections(deps)
    return [...new Set(view.gefunden.map(item => item.connectorId).filter(Boolean) as string[])]
}

/** Telegram: short answer to „womit kannst du dich verbinden?“ (no slash command needed). */
export async function formatConnectionsText(deps: ViewDeps = {}): Promise<string> {
    const view = await collectConnections(deps)
    const lines: string[] = ['🔌 Verbindungen']
    const connected = view.verbunden.filter(item => item.status === 'verbunden')
    lines.push(connected.length ? `Verbunden: ${connected.map(item => item.title).join(', ')}` : 'Verbunden: noch nichts')
    const waiting = view.verbunden.filter(item => item.status !== 'verbunden')
    if (waiting.length) lines.push(`Wartet: ${waiting.map(item => `${item.title} (${item.status === 'abgelaufen' ? 'Anmeldung abgelaufen' : item.status === 'wartet-auf-zugang' ? 'Zugang fehlt' : item.status === 'fehler' ? 'Fehler' : 'Anmeldung fehlt'})`).join(', ')}`)
    const found = view.gefunden.filter(item => !item.verbunden)
    if (found.length) lines.push(`Gefunden: ${found.slice(0, 6).map(item => item.title).join(', ')}`)
    for (const group of view.moeglich.gruppen) {
        const open = group.eintraege.filter(item => item.status === 'moeglich')
        if (open.length) lines.push(`${group.label}: ${open.map(item => `${item.title} (${item.datenklasse})`).join(', ')}`)
    }
    if (view.moeglich.verzeichnis.anzahl) lines.push(`Dazu ${view.moeglich.verzeichnis.anzahl} weitere aus dem MCP-Verzeichnis (nicht geprüft).`)
    lines.push('Verbinden: in der Desktop-App unter „Verbindungen“ oder „/verbindungen verbinden <name>“ — es kommt eine Karte, ohne dein Ja passiert nichts.')
    return lines.join('\n')
}

/** Community search with cached icons only (no network while listing). */
export function searchCommunity(query: string, deps: Pick<ViewDeps, 'directoryCachePath'> & { iconDir?: string } = {}): Array<CommunityEntry & { iconData: string | null }> {
    return searchDirectory(query, { cachePath: deps.directoryCachePath, limit: 40 }).map(entry => ({ ...entry, iconData: entry.icon ? cachedIcon(entry.icon.src, deps.iconDir) : null }))
}
