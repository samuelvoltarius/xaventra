/**
 * 2.85 Paket A — geprüfter Connector-Katalog (Stufe 1 „Empfohlen (geprüft)“).
 *
 * One manifest per connector (Alfred 02.10., Abgleich Zweitmeinung): name,
 * title, kategorie, icon_url + icon_hash (sha256), auth_typ, capabilities per
 * tool (lesen/schreiben/senden/schalten/loeschen), datenklasse (lokal/cloud),
 * trust, quelle (registry id/version or the vendor's documentation).
 *
 * Same path as the install catalog (src/install/install-catalog.ts): part of
 * the release, compiled into dist, validated at load (entries that fail are
 * rejected, never repaired), hashed canonically and published in
 * docs/generated/connector-catalog.json (`npm run check:catalogs` in CI), with
 * a detached ed25519 signature over the catalog hash (`signConnectorCatalog`).
 *
 * Nothing in here is a shell string: a stdio connector is a fixed program
 * (`npx`/`uvx`) plus an argument array with a pinned package version. Local
 * addresses and folders are only placeholders (`{basis}`, `{ordner}`) that the
 * connect flow fills from discovery or the owner — never from a model.
 */
import { sign, verify } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../install/install-catalog.js'
import { BUILTIN_CONNECTOR_ICONS } from './connector-icons.js'

export type ConnectorKategorie = 'zuhause' | 'kommunikation' | 'kalender' | 'dateien' | 'entwicklung' | 'infrastruktur'
export type ConnectorAuth = 'oauth' | 'ha-login' | 'token' | 'keiner'
export type ConnectorCapability = 'lesen' | 'schreiben' | 'senden' | 'schalten' | 'loeschen'
export type Datenklasse = 'lokal' | 'cloud'
export type ConnectorTrust = 'geprueft' | 'community'

export const CONNECTOR_KATEGORIEN: readonly ConnectorKategorie[] = Object.freeze(['zuhause', 'kommunikation', 'kalender', 'dateien', 'entwicklung', 'infrastruktur'])
export const KATEGORIE_LABEL: Readonly<Record<ConnectorKategorie, string>> = Object.freeze({
    zuhause: 'Zuhause', kommunikation: 'Kommunikation', kalender: 'Kalender', dateien: 'Dateien', entwicklung: 'Entwicklung', infrastruktur: 'Infrastruktur',
})
export const CONNECTOR_CAPABILITIES: readonly ConnectorCapability[] = Object.freeze(['lesen', 'schreiben', 'senden', 'schalten', 'loeschen'])

export type ConnectorTransport =
    | { art: 'http'; url: string }
    | { art: 'stdio'; command: 'npx' | 'uvx'; args: string[]; env?: Record<string, string> }

/** A value the owner provides once (Proxmox host + API token). Stored only in the secrets file (0600). */
export interface ConnectorZugangsFeld { env: string; label: string; geheim: boolean }

export interface ConnectorManifest {
    name: string
    title: string
    kategorie: ConnectorKategorie
    /** One short sentence: what Xaventra can do once connected ("kann dann Lichter schalten"). */
    wirkung: string
    icon_url: string
    icon_hash: string
    auth_typ: ConnectorAuth
    /** OAuth scopes requested at login (oauth only). */
    scopes?: string[]
    /** Values the owner enters once (token only). */
    zugang?: ConnectorZugangsFeld[]
    transport: ConnectorTransport
    /** Per tool. Tools not listed fall back to `standard_capability`, then to the MCP annotations, then to a card. */
    capabilities: Record<string, ConnectorCapability>
    standard_capability?: ConnectorCapability
    datenklasse: Datenklasse
    trust: 'geprueft'
    quelle: { url: string; registry_id?: string; version?: string }
    /** Discovery mapping (src/sensing): which found device/account means "this service is here". */
    findet?: { geraet?: 'homeassistant'; konto?: 'gmail' | 'google-calendar' }
    /** Need signals (connection-demand.ts): failing tool names (prefix) and request words. */
    bedarf?: { werkzeuge?: string[]; woerter?: string[] }
}

const NAME = /^[a-z][a-z0-9-]{1,39}$/
const TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/
const ENV = /^[A-Z][A-Z0-9_]{1,40}$/
const SCOPE = /^https:\/\/www\.googleapis\.com\/auth\/[a-z.]+$|^[a-z][a-z:._-]{1,60}$/
/** npm `@scope/name@x.y.z` or pypi `name==x.y.z`, flags, and the two placeholders. Nothing else. */
const PINNED_NPM = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,80}@\d+\.\d+\.\d+$/
const PINNED_PYPI = /^[a-z0-9][a-z0-9._-]{0,80}==\d+\.\d+\.\d+$/
const SAFE_ARG = /^(?:-y|--from|\{ordner\}|--read-only)$/
const ENV_VALUE = /^[a-z0-9._-]{1,40}$/

function checkUrl(url: unknown, allowBase: boolean): string | null {
    if (typeof url !== 'string' || url.length > 300) return 'url fehlt'
    if (allowBase && url.startsWith('{basis}/')) return /^\{basis\}\/[a-z0-9/_-]{1,80}$/.test(url) ? null : 'Pfad hinter {basis} ungültig'
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return 'nur https ohne Zugangsdaten/Query'
        return null
    } catch { return 'url ungültig' }
}

/** Validates one manifest. Returns the reason for refusal or null. */
export function validateConnectorManifest(raw: unknown): string | null {
    const e = raw as ConnectorManifest
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'Eintrag muss ein Objekt sein'
    const allowed = ['name', 'title', 'kategorie', 'wirkung', 'icon_url', 'icon_hash', 'auth_typ', 'scopes', 'zugang', 'transport', 'capabilities',
        'standard_capability', 'datenklasse', 'trust', 'quelle', 'findet', 'bedarf']
    const unknown = Object.keys(e).find(key => !allowed.includes(key))
    if (unknown) return `unbekanntes Feld ${unknown}`
    if (typeof e.name !== 'string' || !NAME.test(e.name)) return 'ungültiger Name'
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 60) return 'Titel fehlt'
    if (typeof e.wirkung !== 'string' || !e.wirkung.trim() || e.wirkung.length > 120) return 'Wirkung fehlt'
    if (!CONNECTOR_KATEGORIEN.includes(e.kategorie)) return 'unbekannte Kategorie'
    if (!['oauth', 'ha-login', 'token', 'keiner'].includes(e.auth_typ)) return 'unbekannter auth_typ'
    if (!['lokal', 'cloud'].includes(e.datenklasse)) return 'ungültige datenklasse'
    if (e.trust !== 'geprueft') return 'trust: im Katalog nur geprueft'
    if (typeof e.icon_url !== 'string' || !/^xaventra:icons\/[a-z0-9-]{2,40}\.svg$/.test(e.icon_url)) return 'icon_url: nur mitgelieferte Icons'
    if (typeof e.icon_hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.icon_hash)) return 'icon_hash fehlt'
    if (e.scopes !== undefined && (!Array.isArray(e.scopes) || e.auth_typ !== 'oauth' || e.scopes.some(scope => typeof scope !== 'string' || !SCOPE.test(scope)))) return 'ungültige scopes'
    if (e.zugang !== undefined) {
        if (!Array.isArray(e.zugang) || e.auth_typ !== 'token' || !e.zugang.length || e.zugang.length > 6) return 'zugang nur für token'
        for (const field of e.zugang) {
            if (!field || !ENV.test(String(field.env)) || typeof field.label !== 'string' || !field.label || field.label.length > 60 || typeof field.geheim !== 'boolean') return 'zugang: Feld ungültig'
        }
    }
    if (e.auth_typ === 'token' && !e.zugang?.length) return 'token ohne zugang'
    const t = e.transport as ConnectorTransport
    if (!t || typeof t !== 'object') return 'transport fehlt'
    if (t.art === 'http') {
        if (Object.keys(t).some(key => !['art', 'url'].includes(key))) return 'transport: unbekanntes Feld'
        const issue = checkUrl(t.url, e.datenklasse === 'lokal')
        if (issue) return `transport: ${issue}`
    } else if (t.art === 'stdio') {
        if (Object.keys(t).some(key => !['art', 'command', 'args', 'env'].includes(key))) return 'transport: unbekanntes Feld'
        if (t.command !== 'npx' && t.command !== 'uvx') return 'transport: Programm nicht erlaubt'
        if (!Array.isArray(t.args) || !t.args.length || t.args.length > 8) return 'transport: Argumente fehlen'
        const pinned = t.args.filter(arg => typeof arg === 'string' && (t.command === 'npx' ? PINNED_NPM : PINNED_PYPI).test(arg))
        if (pinned.length !== 1) return 'transport: genau ein Paket mit fester Version nötig'
        for (const arg of t.args) if (typeof arg !== 'string' || !(SAFE_ARG.test(arg) || pinned.includes(arg) || /^[a-z0-9][a-z0-9_-]{1,40}$/.test(arg))) return 'transport: unzulässiges Argument'
        if (t.env !== undefined) {
            if (!t.env || typeof t.env !== 'object') return 'transport: env ungültig'
            for (const [key, value] of Object.entries(t.env)) if (!ENV.test(key) || typeof value !== 'string' || !ENV_VALUE.test(value)) return 'transport: env ungültig'
        }
    } else return 'transport: unbekannte Art'
    if (!e.capabilities || typeof e.capabilities !== 'object' || Array.isArray(e.capabilities)) return 'capabilities fehlen'
    const caps = Object.entries(e.capabilities)
    if (!caps.length || caps.length > 120) return 'capabilities fehlen'
    for (const [tool, capability] of caps) if (!TOOL.test(tool) || !CONNECTOR_CAPABILITIES.includes(capability)) return `capability ungültig (${tool.slice(0, 40)})`
    if (e.standard_capability !== undefined && !CONNECTOR_CAPABILITIES.includes(e.standard_capability)) return 'standard_capability ungültig'
    if (!e.quelle || typeof e.quelle !== 'object' || checkUrl(e.quelle.url, false)) return 'quelle fehlt'
    if (Object.keys(e.quelle).some(key => !['url', 'registry_id', 'version'].includes(key))) return 'quelle: unbekanntes Feld'
    if (e.quelle.registry_id !== undefined && !/^[a-zA-Z0-9.-]{2,80}\/[a-zA-Z0-9._-]{1,80}$/.test(e.quelle.registry_id)) return 'quelle: registry_id ungültig'
    if (e.quelle.version !== undefined && !/^\d+\.\d+\.\d+$/.test(e.quelle.version)) return 'quelle: version ungültig'
    if (e.findet !== undefined) {
        if (Object.keys(e.findet).some(key => !['geraet', 'konto'].includes(key))) return 'findet: unbekanntes Feld'
        if (e.findet.geraet !== undefined && e.findet.geraet !== 'homeassistant') return 'findet: unbekanntes Gerät'
        if (e.findet.konto !== undefined && !['gmail', 'google-calendar'].includes(e.findet.konto)) return 'findet: unbekanntes Konto'
    }
    if (e.bedarf !== undefined) {
        if (Object.keys(e.bedarf).some(key => !['werkzeuge', 'woerter'].includes(key))) return 'bedarf: unbekanntes Feld'
        if ((e.bedarf.werkzeuge || []).some(item => !/^[a-z][a-z0-9_]{1,40}$/.test(String(item)))) return 'bedarf: Werkzeug ungültig'
        if ((e.bedarf.woerter || []).some(item => !/^[a-zäöüß]{2,30}$/.test(String(item)))) return 'bedarf: Wort ungültig'
    }
    return null
}

const icon = (file: string): Pick<ConnectorManifest, 'icon_url' | 'icon_hash'> => ({ icon_url: `xaventra:icons/${file}`, icon_hash: ICON_HASH[file] })
const ICON_HASH: Readonly<Record<string, string>> = Object.freeze({
    'home-assistant.svg': '485879a2a7f8442ca5ad3b8642597432992fc19bda10591ae9fe9a0842f13739',
    'google-calendar.svg': '8bb4427315c5d3ea72db8601dbcae1b407c7d5c48b5dff6a72153548849648c4',
    'gmail.svg': 'a3d1817c55cba11d2b18cc9d4b8748523856b747bff7a21076cacd2f91751c44',
    'github.svg': '623b9c60ae16e27d1e8762116afc7761c1c3fdb59d570410fa5531aca6e45700',
    'proxmox.svg': 'af0827f30c21e569c8d90bf7d1d322b561f9cae3b5235e2af7f942b297f29c8f',
    'dateien.svg': '1da3e1114564e202400e18a883079d4e732a3d937731de20d5d7f5494728a3ab',
})

/**
 * Stufe 1 start set. Every entry is documented by its vendor or by the official
 * MCP registry (checked 02.10.2026, sources in `quelle`).
 */
export const BUILTIN_CONNECTORS: readonly ConnectorManifest[] = Object.freeze([
    {
        // Home Assistant's own MCP server integration: Streamable HTTP at /api/mcp,
        // IndieAuth login (no client registration), long-lived tokens as fallback.
        // HA ≥ 2026.9 prefixes tool names with the domain (intent__HassTurnOn).
        name: 'home-assistant', title: 'Home Assistant', kategorie: 'zuhause', wirkung: 'kann dann Lichter, Steckdosen und Geräte schalten und den Zustand lesen',
        ...icon('home-assistant.svg'), auth_typ: 'ha-login',
        transport: { art: 'http', url: '{basis}/api/mcp' },
        capabilities: {
            GetLiveContext: 'lesen', homeassistant__GetLiveContext: 'lesen', GetDateTime: 'lesen', homeassistant__GetDateTime: 'lesen',
            HassTurnOn: 'schalten', intent__HassTurnOn: 'schalten', HassTurnOff: 'schalten', intent__HassTurnOff: 'schalten',
            HassLightSet: 'schalten', intent__HassLightSet: 'schalten', HassFanSetSpeed: 'schalten', intent__HassFanSetSpeed: 'schalten',
            HassClimateSetTemperature: 'schalten', intent__HassClimateSetTemperature: 'schalten',
        },
        datenklasse: 'lokal', trust: 'geprueft',
        quelle: { url: 'https://www.home-assistant.io/integrations/mcp_server/' },
        findet: { geraet: 'homeassistant' },
        bedarf: { werkzeuge: ['hass_'], woerter: ['licht', 'lampe', 'steckdose', 'heizung', 'rollladen'] },
    },
    {
        // Google Workspace remote MCP server (rollout from 01.05.2026), OAuth client of the owner, no DCR.
        name: 'google-calendar', title: 'Google Kalender', kategorie: 'kalender', wirkung: 'kann dann Termine lesen und freie Zeiten finden',
        ...icon('google-calendar.svg'), auth_typ: 'oauth',
        scopes: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.events.readonly'],
        transport: { art: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
        capabilities: {
            list_events: 'lesen', get_event: 'lesen', list_calendars: 'lesen', suggest_time: 'lesen',
            create_event: 'schreiben', update_event: 'schreiben', delete_event: 'loeschen', respond_to_event: 'senden',
        },
        datenklasse: 'cloud', trust: 'geprueft',
        quelle: { url: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server' },
        findet: { konto: 'google-calendar' },
        bedarf: { werkzeuge: ['calendar_', 'kalender_'], woerter: ['kalender', 'termin', 'termine', 'besprechung'] },
    },
    {
        // Gmail remote MCP server: reads, drafts and labels; it cannot send (drafts only).
        name: 'gmail', title: 'Gmail', kategorie: 'kommunikation', wirkung: 'kann dann Mails lesen, suchen und Entwürfe anlegen (senden nie)',
        ...icon('gmail.svg'), auth_typ: 'oauth',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
        transport: { art: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        capabilities: {
            list_drafts: 'lesen', get_thread: 'lesen', get_message: 'lesen', search_threads: 'lesen', list_labels: 'lesen',
            create_draft: 'schreiben', label_thread: 'schreiben', unlabel_thread: 'schreiben', label_message: 'schreiben', unlabel_message: 'schreiben',
        },
        datenklasse: 'cloud', trust: 'geprueft',
        quelle: { url: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server' },
        findet: { konto: 'gmail' },
        bedarf: { werkzeuge: ['gmail_', 'mail_'], woerter: ['mail', 'mails', 'postfach', 'posteingang'] },
    },
    {
        // Official GitHub MCP server, remote endpoint (registry io.github.github/github-mcp-server 1.13.0).
        name: 'github', title: 'GitHub', kategorie: 'entwicklung', wirkung: 'kann dann Repositories, Issues und Pull Requests lesen',
        ...icon('github.svg'), auth_typ: 'oauth', scopes: ['repo', 'read:org'],
        transport: { art: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        capabilities: {
            get_me: 'lesen', search_repositories: 'lesen', get_file_contents: 'lesen', list_issues: 'lesen', get_issue: 'lesen',
            list_pull_requests: 'lesen', get_pull_request: 'lesen', search_code: 'lesen',
            create_issue: 'schreiben', update_issue: 'schreiben', create_pull_request: 'schreiben', merge_pull_request: 'schreiben',
            add_issue_comment: 'senden', create_or_update_file: 'schreiben', push_files: 'schreiben', delete_file: 'loeschen',
        },
        datenklasse: 'cloud', trust: 'geprueft',
        quelle: { url: 'https://github.com/github/github-mcp-server', registry_id: 'io.github.github/github-mcp-server', version: '1.13.0' },
        bedarf: { werkzeuge: ['github_', 'gh_'], woerter: ['github', 'issue', 'issues'] },
    },
    {
        // Community server from the official registry, read-only by default (PROXMOX_RISK_LEVEL=read, fixed here).
        // Xaventra's own Proxmox adapter (src/infra/proxmox.ts) keeps all write actions behind its cards.
        name: 'proxmox', title: 'Proxmox VE', kategorie: 'infrastruktur', wirkung: 'kann dann VMs, Container und Speicher lesend sehen',
        ...icon('proxmox.svg'), auth_typ: 'token',
        zugang: [
            { env: 'PROXMOX_HOST', label: 'Proxmox-Adresse', geheim: false },
            { env: 'PROXMOX_USER', label: 'API-Benutzer (z. B. root@pam)', geheim: false },
            { env: 'PROXMOX_TOKEN_NAME', label: 'API-Token-Name', geheim: false },
            { env: 'PROXMOX_TOKEN_VALUE', label: 'API-Token-Wert', geheim: true },
        ],
        transport: { art: 'stdio', command: 'uvx', args: ['proxmox-ve-mcp==2.3.0'], env: { PROXMOX_RISK_LEVEL: 'read' } },
        capabilities: { get_nodes: 'lesen', get_vms: 'lesen', get_containers: 'lesen', get_storage: 'lesen', get_cluster_status: 'lesen' },
        // Only valid because the server is started with PROXMOX_RISK_LEVEL=read (32 read tools only);
        // name heuristics (start/stop/delete …) still raise a tool to a card.
        standard_capability: 'lesen',
        datenklasse: 'lokal', trust: 'geprueft',
        quelle: { url: 'https://github.com/akmalovaa/proxmox-mcp', registry_id: 'io.github.akmalovaa/proxmox-mcp', version: '2.3.0' },
        bedarf: { werkzeuge: ['proxmox_', 'pve_'], woerter: ['proxmox', 'vm', 'vms'] },
    },
    {
        // Reference filesystem server of the MCP project; one folder (NAS share or local), chosen by the owner.
        name: 'dateien', title: 'Dateien / NAS-Ordner', kategorie: 'dateien', wirkung: 'kann dann in einem freigegebenen Ordner lesen und suchen',
        ...icon('dateien.svg'), auth_typ: 'keiner',
        transport: { art: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', '{ordner}'] },
        capabilities: {
            read_text_file: 'lesen', read_media_file: 'lesen', read_multiple_files: 'lesen', list_directory: 'lesen', list_directory_with_sizes: 'lesen',
            directory_tree: 'lesen', search_files: 'lesen', get_file_info: 'lesen', list_allowed_directories: 'lesen',
            create_directory: 'schreiben', write_file: 'schreiben', edit_file: 'schreiben', move_file: 'schreiben',
        },
        datenklasse: 'lokal', trust: 'geprueft',
        quelle: { url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
        bedarf: { woerter: ['nas', 'freigabe', 'ordner'] },
    },
] satisfies ConnectorManifest[])

export interface RejectedConnector { id: string; reason: string }
export interface ConnectorCatalog { version: 1; entries: ConnectorManifest[]; rejected: RejectedConnector[]; hash: string }

export function connectorEntryHash(entry: ConnectorManifest): string { return sha256Hex(canonicalJson(entry)) }

/** Loads and validates a catalog. Entries that fail are rejected, never repaired. */
export function loadConnectorCatalog(raw: readonly unknown[] = BUILTIN_CONNECTORS): ConnectorCatalog {
    const entries: ConnectorManifest[] = []
    const rejected: RejectedConnector[] = []
    const seen = new Set<string>()
    for (const item of raw) {
        const id = typeof (item as any)?.name === 'string' ? (item as any).name : '?'
        const reason = validateConnectorManifest(item) || (seen.has(id) ? 'doppelter Name' : null)
        if (reason) { rejected.push({ id: String(id).slice(0, 40), reason }); continue }
        seen.add(id)
        entries.push(structuredClone(item) as ConnectorManifest)
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return { version: 1, entries, rejected, hash: sha256Hex(canonicalJson(entries)) }
}

let builtin: ConnectorCatalog | null = null
export function getConnectorCatalog(): ConnectorCatalog {
    builtin ||= loadConnectorCatalog()
    return builtin
}
export function findConnector(name: unknown, catalog = getConnectorCatalog()): ConnectorManifest | undefined {
    if (typeof name !== 'string' || !NAME.test(name)) return undefined
    return catalog.entries.find(entry => entry.name === name)
}

/** The shipped icon as data URI, only when its bytes match `icon_hash`. */
export function resolveConnectorIcon(entry: Pick<ConnectorManifest, 'icon_url' | 'icon_hash'>): string | null {
    const file = /^xaventra:icons\/([a-z0-9-]{2,40}\.svg)$/.exec(String(entry?.icon_url || ''))?.[1]
    const svg = file ? BUILTIN_CONNECTOR_ICONS[file] : undefined
    if (!svg || sha256Hex(svg) !== entry.icon_hash) return null
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/** Detached release signature over the catalog hash (operator key, never in the repo). */
export function signConnectorCatalog(catalog: ConnectorCatalog, privateKey: string): string {
    return sign(null, Buffer.from(`xaventra-connector-catalog:${catalog.hash}`), privateKey).toString('base64')
}
export function verifyConnectorCatalogSignature(catalog: ConnectorCatalog, signature: string, publicKey: string): boolean {
    try { return verify(null, Buffer.from(`xaventra-connector-catalog:${catalog.hash}`), publicKey, Buffer.from(String(signature || ''), 'base64')) }
    catch { return false }
}

/** Published form for docs/generated (hash is reproducible from source). */
export function publishedConnectorCatalog(catalog = getConnectorCatalog()): { version: 1; catalogHash: string; entries: unknown[]; rejected: RejectedConnector[] } {
    return { version: 1, catalogHash: catalog.hash, entries: catalog.entries.map(entry => ({ ...entry, entryHash: connectorEntryHash(entry) })), rejected: catalog.rejected }
}
