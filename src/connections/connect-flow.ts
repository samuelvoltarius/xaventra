/**
 * 2.85 Paket A, Punkt 4 — „Verbinden“ ist eine Karte.
 *
 *   requestConnect  → one approval card „X verbinden?“ (art `verbindung`,
 *                     kind `verbindung-herstellen`, L2 ask, never „immer“).
 *                     The card only carries a request id; what is connected
 *                     is resolved again from the checked catalog (or the
 *                     cached community entry) when the owner says Ja.
 *   Ja              → `establishConnection`: writes the connection record (the
 *                     one config change, approved by that Ja), then:
 *                     keiner → connect + test now; oauth/ha-login → status
 *                     „wartet auf Anmeldung“ (browser login via
 *                     connector-login.ts, then connect + test automatically);
 *                     token → the owner enters the access values once.
 *   Trennen         → disconnect, remove the stored login, status `getrennt`.
 *   Werkzeug erlauben (community) → one non-reading tool becomes visible;
 *                     every call of it still asks.
 *
 * Community entries (Stufe 2) connect only over an https remote. Packages
 * from the directory are never installed or started automatically.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import { findConnector, getConnectorCatalog, KATEGORIE_LABEL, type ConnectorCatalog, type ConnectorManifest } from './connector-catalog.js'
import { findDirectoryEntry, type CommunityEntry } from './registry-directory.js'
import {
    connectionIdFor, deleteConnectionSecrets, getConnection, loadConnections, saveConnection, updateConnection, updateConnectionSecrets,
    type ConnectionRecord, type ConnectionTestResult,
} from './connection-store.js'
import { haBearerFetch, isAuthFailure, markLoginExpired, startLogin, type LoginDeps } from './connector-login.js'

export const CONNECT_CARD_KIND = 'verbindung-herstellen'
const REQUEST_ID = /^r-[a-f0-9]{16}$/
const TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/

/** The part of the MCP runtime the flow needs (real: mcp-runtime.ts; tests: a fake). */
export interface ConnectionGateway {
    connect(record: ConnectionRecord): Promise<ConnectionTestResult>
    disconnect(record: ConnectionRecord): void | Promise<void>
}

export interface ConnectDeps extends LoginDeps {
    gateway?: ConnectionGateway
    cardOpts?: CardStoreOptions
    catalog?: ConnectorCatalog
    directoryCachePath?: string
    /** Found Home Assistant instances (default: sensing device file). */
    foundHomeAssistant?: () => string[]
    /** 2.85: found base addresses of a device type (n8n, paperless, immich …); default: sensing device file. */
    foundServices?: (type: string) => string[]
}

interface ConnectRequest { id: string; connectorId: string; community: boolean; basis?: string; ordner?: string; createdAt: number; quelle: string }

const requestsFile = (deps: ConnectDeps) => join(deps.dataDir || getNovaDataDir(), 'connections', 'requests.json')
function readRequests(deps: ConnectDeps): ConnectRequest[] {
    try { return existsSync(requestsFile(deps)) ? (JSON.parse(readFileSync(requestsFile(deps), 'utf8'))?.requests || []) : [] } catch { return [] }
}
function writeRequests(list: ConnectRequest[], deps: ConnectDeps): void {
    mkdirSync(join(deps.dataDir || getNovaDataDir(), 'connections'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(requestsFile(deps), { version: 1, requests: list.slice(-100) })
}

/** Base address of a local service: http(s), host only (+port), no path/userinfo. */
export function cleanBasis(value: unknown): string | null {
    try {
        const url = new URL(String(value || '').trim())
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
        if (url.pathname !== '/' && url.pathname !== '') return null
        return `${url.protocol}//${url.host}`
    } catch { return null }
}

/** A folder for the files connector: absolute, no traversal, not a filesystem root. */
export function cleanOrdner(value: unknown): string | null {
    const raw = String(value || '').trim()
    if (!raw || raw.length > 260 || /[\u0000-\u001f"<>|*?]/.test(raw) || !isAbsolute(raw)) return null
    const path = normalize(raw)
    if (path.split(/[\\/]+/).includes('..')) return null
    if (/^(?:[A-Za-z]:)?[\\/]*$/.test(path)) return null
    return path.replace(/[\\/]+$/, '')
}

function defaultFoundServices(type: string): string[] {
    try {
        // Device file of the self-discovery (sensing): only owner-network addresses.
        const file = join(getNovaDataDir(), 'sensing', 'devices.json')
        const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
        return (Array.isArray(raw?.devices) ? raw.devices : [])
            .filter((device: any) => device?.type === type && device.status !== 'abgelehnt' && typeof device.host === 'string' && Number(device.port) > 0)
            .map((device: any) => cleanBasis(`http://${device.host}:${Number(device.port)}`)).filter(Boolean) as string[]
    } catch { return [] }
}
const defaultFoundHomeAssistant = () => defaultFoundServices('homeassistant')

/** Base address of a found service for this connector. */
function foundBasis(manifest: ConnectorManifest, deps: ConnectDeps): string | undefined {
    const type = manifest.findet?.geraet
    if (!type) return undefined
    if (type === 'homeassistant') return (deps.foundHomeAssistant || defaultFoundHomeAssistant)()[0]
    return (deps.foundServices || defaultFoundServices)(type)[0]
}

function rightsSummary(manifest: Pick<ConnectorManifest, 'capabilities'>): string {
    const caps = Object.values(manifest.capabilities)
    const reads = caps.filter(cap => cap === 'lesen').length
    const asks = caps.length - reads
    return `${reads} lesende Werkzeuge laufen selbst; ${asks} schreibende/schaltende fragen dich jedes Mal${caps.includes('loeschen') ? '; Löschen macht sie nie' : ''}.`
}

export type RequestResult = { ok: true; message: string; card: ApprovalCard; created: boolean } | { ok: false; message: string }

/** Owner pressed „Verbinden“ (desktop, Telegram) or a need was found: one card. */
export async function requestConnect(input: { connectorId: string; basis?: string; ordner?: string; quelle?: string }, deps: ConnectDeps = defaultDeps()): Promise<RequestResult> {
    const catalog = deps.catalog || getConnectorCatalog()
    const manifest = findConnector(input?.connectorId, catalog)
    const community = manifest ? undefined : findDirectoryEntry(String(input?.connectorId || ''), deps.directoryCachePath)
    if (!manifest && !community) return { ok: false, message: 'Diesen Dienst kenne ich nicht (weder geprüft noch im Verzeichnis).' }
    if (community && !community.remotes.length) return { ok: false, message: `${community.title} gibt es nur als Paket zum Installieren — das führe ich aus dem Verzeichnis nie automatisch aus.` }
    const connectorId = manifest?.name || community!.name
    const existing = getConnection(connectionIdFor(connectorId), deps)
    if (existing && existing.status === 'verbunden') return { ok: false, message: `${existing.title} ist schon verbunden.` }
    let basis: string | undefined
    let ordner: string | undefined
    if (manifest) basis = (input.basis ? cleanBasis(input.basis) : foundBasis(manifest, deps)) || undefined
    if (manifest?.transport.art === 'http' && manifest.transport.url.startsWith('{basis}') && !basis) {
        return { ok: false, message: `Für ${manifest.title} fehlt die Adresse (z. B. http://192.168.1.10:8123) — ich habe keine gefunden.` }
    }
    if (manifest?.transport.art === 'stdio' && manifest.transport.args.includes('{ordner}')) {
        ordner = cleanOrdner(input.ordner) || undefined
        if (!ordner) return { ok: false, message: `Für ${manifest.title} brauche ich genau einen Ordner (vollständiger Pfad, nicht das ganze Laufwerk).` }
    }
    const request: ConnectRequest = { id: `r-${randomBytes(8).toString('hex')}`, connectorId, community: !manifest, basis, ordner, createdAt: (deps.now || Date.now)(), quelle: String(input.quelle || 'owner').slice(0, 20) }
    registerConnectCardExecutor(deps)
    const title = manifest?.title || community!.title
    const where = manifest ? (manifest.datenklasse === 'lokal' ? 'lokal (bleibt im Haus)' : 'Cloud (bekommt nichts Privates)') : 'Cloud/fremd (bekommt nichts Privates)'
    const beleg = manifest
        ? `${manifest.wirkung}. ${KATEGORIE_LABEL[manifest.kategorie]}, ${where}, geprüft. ${rightsSummary(manifest)}${basis ? ` Adresse ${basis}.` : ''}${ordner ? ` Ordner ${ordner}.` : ''}`
        : `NICHT GEPRÜFT (Verzeichnis): ${community!.description || community!.name}. ${where}. Zuerst nur lesende Werkzeuge; Schreiben erst, wenn du ein Werkzeug einzeln erlaubst.`
    const card = createApprovalCard({
        art: 'verbindung', titel: `${title} verbinden?`, beleg,
        vorschlag: `Ja = Verbindung einrichten${manifest?.auth_typ === 'oauth' || manifest?.auth_typ === 'ha-login' || community?.remotes[0]?.auth ? ', dann einmal anmelden' : ''} und testen. Nein = nichts.`,
        aktion: { kind: CONNECT_CARD_KIND, ref: request.id }, wirkung: 'intern', ablaufMs: 24 * 60 * 60_000,
        dedupeKey: `verbindung:${connectorId}`, quelle: 'verbindungen',
    }, deps.cardOpts)
    if (card.ok === false) return { ok: false, message: `Keine Karte: ${card.reason}` }
    if (card.created) writeRequests([...readRequests(deps).filter(item => item.connectorId !== connectorId), request], deps)
    return { ok: true, card: card.card, created: card.created, message: card.created ? `Karte „${title} verbinden?“ erstellt — verbunden wird erst nach deinem Ja.` : `Die Karte „${title} verbinden?“ liegt schon offen.` }
}

function recordFor(request: ConnectRequest, approvedBy: string, manifest: ConnectorManifest | undefined, community: CommunityEntry | undefined, now: number): ConnectionRecord {
    const iso = new Date(now).toISOString()
    const base = { id: connectionIdFor(request.connectorId), connectorId: request.connectorId, createdAt: iso, updatedAt: iso, approvedBy, erlaubteWerkzeuge: [] as string[] }
    if (manifest) {
        const t = manifest.transport
        const transport = t.art === 'http'
            ? { art: 'http' as const, url: t.url.replace('{basis}', request.basis || '') }
            : { art: 'stdio' as const, command: t.command, args: t.args.map(arg => arg === '{ordner}' ? request.ordner! : arg), ...(t.env ? { env: { ...t.env } } : {}) }
        return {
            ...base, trust: 'geprueft', title: manifest.title, kategorie: manifest.kategorie, datenklasse: manifest.datenklasse, auth: manifest.auth_typ,
            transport, status: manifest.auth_typ === 'keiner' ? 'wartet-auf-anmeldung' : manifest.auth_typ === 'token' ? 'wartet-auf-zugang' : 'wartet-auf-anmeldung',
            ...(request.basis ? { basis: request.basis } : {}), capabilities: { ...manifest.capabilities }, ...(manifest.standard_capability ? { standard: manifest.standard_capability } : {}),
        }
    }
    const remote = community!.remotes[0]
    return {
        ...base, trust: 'community', title: community!.title, kategorie: 'weitere', datenklasse: 'cloud', auth: remote.auth ? 'oauth' : 'keiner',
        transport: { art: 'http', url: remote.url }, status: 'wartet-auf-anmeldung',
    }
}

/** Card „Ja“: write the connection (the approved config change), then log in or connect. */
export async function establishConnection(requestId: string, approvedBy: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    if (!REQUEST_ID.test(String(requestId || ''))) return { ok: false, message: 'Ungültige Karten-Referenz — nichts eingerichtet.' }
    const requests = readRequests(deps)
    const request = requests.find(item => item.id === requestId)
    if (!request) return { ok: false, message: 'Diese Anfrage gibt es nicht mehr — nichts eingerichtet.' }
    writeRequests(requests.filter(item => item.id !== requestId), deps)
    // Resolved again from the release catalog / the cache — never from the card text.
    const manifest = request.community ? undefined : findConnector(request.connectorId, deps.catalog || getConnectorCatalog())
    const community = request.community ? findDirectoryEntry(request.connectorId, deps.directoryCachePath) : undefined
    if (!manifest && !community?.remotes.length) return { ok: false, message: 'Der Dienst steht nicht mehr im Katalog/Verzeichnis — nichts eingerichtet.' }
    const record = saveConnection(recordFor(request, approvedBy, manifest, community, (deps.now || Date.now)()), deps)
    if (record.auth === 'keiner') return connectAndTest(record.id, deps)
    if (record.auth === 'token') return { ok: true, message: `${record.title} eingerichtet. Bitte einmal den Zugang in „Verbindungen“ eintragen; danach teste ich selbst.` }
    return { ok: true, message: `${record.title} eingerichtet. Jetzt einmal anmelden: „Verbindungen“ → Anmelden (oder „/verbindungen anmelden ${record.connectorId}“). Danach verbinde und teste ich selbst.` }
}

/**
 * Ja on a need thought („Home Assistant verbinden?“, connection-demand.ts): that Ja is
 * the approval of the config change, exactly like the card — no second question.
 */
export async function connectFromApproval(connectorId: string, approvedBy: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string; link?: { label: string; url: string } }> {
    const manifest = findConnector(connectorId, deps.catalog || getConnectorCatalog())
    if (!manifest) return { ok: false, message: 'Diesen Dienst gibt es nicht im geprüften Katalog — nichts eingerichtet.' }
    const existing = getConnection(connectionIdFor(manifest.name), deps)
    if (existing?.status === 'verbunden') return { ok: true, message: `${manifest.title} ist schon verbunden.` }
    const basis = foundBasis(manifest, deps)
    if (manifest.transport.art === 'http' && manifest.transport.url.startsWith('{basis}') && !basis) {
        return { ok: false, message: `${manifest.title}: keine Adresse gefunden — bitte in „Verbindungen“ mit Adresse verbinden.` }
    }
    if (manifest.transport.art === 'stdio' && manifest.transport.args.includes('{ordner}')) {
        return { ok: false, message: `${manifest.title}: bitte in „Verbindungen“ den Ordner wählen.` }
    }
    const request: ConnectRequest = { id: `r-${randomBytes(8).toString('hex')}`, connectorId: manifest.name, community: false, basis, createdAt: (deps.now || Date.now)(), quelle: 'bedarf' }
    writeRequests([...readRequests(deps).filter(item => item.connectorId !== manifest.name), request], deps)
    const established = await establishConnection(request.id, approvedBy, deps)
    // Discovery already carries the concrete address and the owner's approval.
    // Do not require another command to start the Home Assistant login.
    if (!established.ok || manifest.auth_typ !== 'ha-login') return established
    const login = await beginLogin(connectionIdFor(manifest.name), deps)
    // 2.86 Paket N: ONE sentence + ONE URL button (never the address as text: Telegram
    // pages and owner-text filters must not cut or alter it).
    if (!login.url) return { ok: login.ok, message: login.message }
    const paste = returnOnlyLocal(deps.redirectBase) ? ' Wenn danach eine leere Seite kommt: kopier die Adresse oben aus dem Browser und schick sie mir hier.' : ''
    return { ok: true, link: { label: 'Bei Home Assistant anmelden', url: login.url },
        message: `Ein Schritt noch: Bei Home Assistant anmelden. Der Knopf gilt eine Viertelstunde.${paste} Danach sehe ich deine Geräte; geschaltet wird nichts.` }
}

/** Browser return: finish the login, then connect and test automatically. */
export async function completeLoginAndConnect(input: { state?: unknown; code?: unknown; error?: unknown; address?: unknown }, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    const { finishLogin, finishLoginFromAddress } = await import('./connector-login.js')
    const finished = input.address !== undefined ? await finishLoginFromAddress(input.address, deps) : await finishLogin(input, deps)
    if (finished.ok === false) return { ok: false, message: finished.message }
    const tested = await connectAndTest(finished.connectionId, deps)
    // 2.86 Paket N: „und?“ answers the last connection from memory.
    try {
        const { beendeVorgang } = await import('../sensing/connect-progress.js')
        if (getConnection(finished.connectionId, deps)?.connectorId === 'home-assistant') {
            beendeVorgang(deps.dataDir || (await import('../core/data-root.js')).getNovaDataDir(), 'homeassistant', tested.ok ? 'verbunden' : 'fehlgeschlagen',
                tested.ok ? '✅ Home Assistant verbunden. Ich lese jetzt deine Geräte.' : tested.message, { gemeldet: true })
        }
    } catch { /* progress is a convenience */ }
    return tested
}

/** Home Assistant without the MCP server integration answers POST /api/mcp with 404. */
const isMcpEndpointMissing = (error: unknown) => /\b404\b|not found/i.test(String((error as any)?.message || error || ''))
const HA_REST_OK = 'Home Assistant ist verbunden. Ich lese jetzt deine Geräte; geschaltet wird nur, wenn du es sagst und Ja drückst.'
const HA_NICHT_ERREICHBAR = 'Home Assistant antwortet gerade nicht richtig. Ich habe nichts verändert und versuche es später noch einmal.'

/**
 * 2.86.1 (d): the same login, the normal HA interface (`GET /api/` → „API running.“).
 * Read only; the bearer comes fresh from the secrets store (refresh before expiry).
 */
async function haRestTest(record: ConnectionRecord, deps: ConnectDeps): Promise<{ ok: boolean; message: string }> {
    const at = new Date((deps.now || Date.now)()).toISOString()
    try {
        const base = String(record.basis || '').replace(/\/+$/, '')
        const response = await haBearerFetch(record.id, deps)(`${base}/api/`, { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) } as any)
        const body = response.ok ? await response.text() : ''
        if (response.ok && /API running/i.test(body)) {
            updateConnection(record.id, { status: 'verbunden', weg: 'rest', loginAskedAt: undefined, letzterTest: { ok: true, at, werkzeuge: 0, lesend: 0, fragend: 0, gesperrt: 0 } }, deps)
            return { ok: true, message: HA_REST_OK }
        }
        if (response.status === 401) return { ok: false, message: `${record.title}: Anmeldung fehlt oder ist abgelaufen — bitte einmal neu anmelden.` }
        updateConnection(record.id, { status: 'fehler', letzterTest: { ok: false, at, werkzeuge: 0, lesend: 0, fragend: 0, gesperrt: 0, fehler: `HA-Schnittstelle: Status ${response.status}` } }, deps)
        return { ok: false, message: HA_NICHT_ERREICHBAR }
    } catch (error) {
        if (isAuthFailure(error)) return { ok: false, message: `${record.title}: Anmeldung fehlt oder ist abgelaufen — bitte einmal neu anmelden.` }
        updateConnection(record.id, { status: 'fehler', letzterTest: { ok: false, at, werkzeuge: 0, lesend: 0, fragend: 0, gesperrt: 0, fehler: 'HA-Schnittstelle nicht erreichbar' } }, deps)
        return { ok: false, message: HA_NICHT_ERREICHBAR }
    }
}

/** Connect through the MCP runtime and test (tools listed). Expired login → exactly one request. */
export async function connectAndTest(connectionId: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    const record = getConnection(connectionId, deps)
    if (!record) return { ok: false, message: 'Unbekannte Verbindung.' }
    const haLogin = record.connectorId === 'home-assistant' && record.auth === 'ha-login'
    // 2.86.1 (d): a Home Assistant already known to run without its MCP integration is tested directly.
    if (haLogin && record.weg === 'rest') return haRestTest(record, deps)
    const gateway = deps.gateway || await defaultGateway(deps)
    try {
        const test = await gateway.connect(record)
        updateConnection(record.id, { status: test.ok ? 'verbunden' : 'fehler', letzterTest: test, ...(test.ok ? { loginAskedAt: undefined } : {}) }, deps)
        return test.ok
            ? { ok: true, message: `${record.title} verbunden und getestet: ${test.werkzeuge} Werkzeuge (${test.lesend} lesend selbst, ${test.fragend} fragen dich${test.gesperrt ? `, ${test.gesperrt} gesperrt` : ''}).` }
            : { ok: false, message: `${record.title}: Test fehlgeschlagen (${test.fehler || 'keine Werkzeuge'}).` }
    } catch (error) {
        if (isAuthFailure(error)) {
            await markLoginExpired(record.id, deps)
            return { ok: false, message: `${record.title}: Anmeldung fehlt oder ist abgelaufen — bitte einmal neu anmelden.` }
        }
        // 2.86.1 (d): HA without the MCP server integration → the same login over the normal HA interface.
        if (haLogin && isMcpEndpointMissing(error)) return haRestTest(record, deps)
        const fehler = String(error instanceof Error ? error.message : error).replace(/(bearer|token|code)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 160)
        updateConnection(record.id, { status: 'fehler', letzterTest: { ok: false, at: new Date((deps.now || Date.now)()).toISOString(), werkzeuge: 0, lesend: 0, fragend: 0, gesperrt: 0, fehler } }, deps)
        // 2.86 Paket N: a blocked address (SSRF guard) never reaches the owner as raw text.
        if (/ssrf|private address|blocked/i.test(fehler)) return { ok: false, message: `${record.title} ist von hier aus gerade nicht erreichbar. Ich habe nichts verändert.` }
        // 2.86.1: the technical reason stays in the test record (app); the owner gets one plain sentence.
        return { ok: false, message: `${record.title} hat die Verbindung gerade nicht angenommen. Ich habe nichts verändert; die Einzelheiten stehen in der App unter „Verbindungen“.` }
    }
}

/** Login for a connection (desktop button, `/verbindungen anmelden`, Ja on the expiry request). */
export async function beginLogin(connectionId: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string; url?: string }> {
    const result = await startLogin(connectionId, deps)
    if (result.ok === false) return { ok: false, message: result.message }
    if (!result.url) return connectAndTest(connectionId, deps)
    return { ok: true, url: result.url, message: 'Bitte im Browser anmelden; danach geht es automatisch weiter.' }
}

/** Token connectors: the owner enters the values once (stored 0600), then connect + test. */
export async function submitAccess(connectionId: string, values: Record<string, unknown>, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    const record = getConnection(connectionId, deps)
    if (!record || record.auth !== 'token') return { ok: false, message: 'Diese Verbindung braucht keinen Zugang.' }
    const manifest = findConnector(record.connectorId, deps.catalog || getConnectorCatalog())
    const fields = manifest?.zugang || []
    const clean: Record<string, string> = {}
    for (const field of fields) {
        // An address the discovery already found is taken as is (the owner only enters the secret).
        const value = String(values?.[field.env] ?? '').trim() || (!field.geheim && /_URL$|_HOST$/.test(field.env) && record.basis ? record.basis : '')
        if (!value || value.length > 300 || /[\u0000-\u001f]/.test(value)) return { ok: false, message: `${field.label} fehlt oder ist ungültig.` }
        clean[field.env] = value
    }
    updateConnectionSecrets(record.id, current => ({ ...current, zugang: clean }), deps)
    return connectAndTest(record.id, deps)
}

export async function disconnectConnection(connectionId: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    const record = getConnection(connectionId, deps)
    if (!record) return { ok: false, message: 'Unbekannte Verbindung.' }
    try { await (deps.gateway || await defaultGateway(deps)).disconnect(record) } catch { /* already gone */ }
    deleteConnectionSecrets(record.id, deps)
    updateConnection(record.id, { status: 'getrennt', loginAskedAt: undefined, erlaubteWerkzeuge: [] }, deps)
    return { ok: true, message: `${record.title} getrennt; die gespeicherte Anmeldung ist gelöscht.` }
}

/** Community: allow exactly one non-reading tool (owner action); every call of it still asks. */
export async function allowConnectionTool(connectionId: string, tool: string, deps: ConnectDeps = defaultDeps()): Promise<{ ok: boolean; message: string }> {
    const record = getConnection(connectionId, deps)
    if (!record || record.trust !== 'community') return { ok: false, message: 'Nur für nicht geprüfte Verbindungen nötig.' }
    if (!TOOL.test(String(tool || ''))) return { ok: false, message: 'Ungültiger Werkzeugname.' }
    const updated = updateConnection(record.id, { erlaubteWerkzeuge: [...new Set([...record.erlaubteWerkzeuge, tool])].slice(0, 50) }, deps)
    if (updated?.status === 'verbunden') await connectAndTest(record.id, deps)
    return { ok: true, message: `${tool} ist für ${record.title} sichtbar; jeder Aufruf fragt dich weiterhin.` }
}

export function createConnectCardExecutor(deps: ConnectDeps = defaultDeps()): CardExecutor {
    return {
        kind: CONNECT_CARD_KIND,
        impact: 'intern',
        allowAlways: () => false,
        async execute(card, _answer, ctx) {
            if (card.aktion.kind !== CONNECT_CARD_KIND) return { ok: false, message: 'Aktionsart passt nicht — nichts eingerichtet.' }
            return establishConnection(card.aktion.ref, ctx.decidedBy, deps)
        },
        async reject(card) {
            writeRequests(readRequests(deps).filter(item => item.id !== card.aktion.ref), deps)
            return { ok: true, message: 'Nicht verbunden; ich frage danach nicht von selbst wieder.' }
        },
    }
}

export function registerConnectCardExecutor(deps: ConnectDeps = defaultDeps(), options: { force?: boolean } = {}): void {
    if (!options.force && getCardExecutor(CONNECT_CARD_KIND) && !deps.cardOpts) return
    registerCardExecutor(createConnectCardExecutor(deps))
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

export function defaultDeps(): ConnectDeps {
    return { redirectBase: currentRedirectBase(), askLogin: record => askLoginAgain(record) }
}

let dashboardReturnBase = ''
/** 2.86 Paket N: the dashboard's real listener (dashboard/server.ts) — only a non-loopback one helps another browser. */
export function noteDashboardAddress(url: string): void {
    try {
        const parsed = new URL(String(url || ''))
        const host = parsed.hostname.replace(/^\[|\]$/g, '')
        dashboardReturnBase = !host || /^(?:127\.|localhost$|::1$|0\.0\.0\.0$|::$)/.test(host) ? '' : `${parsed.protocol}//${parsed.host}`
    } catch { dashboardReturnBase = '' }
}

/** True when only a browser on the Main itself can reach the return address (paste fallback needed). */
export function returnOnlyLocal(base: string): boolean {
    try { return /^(?:127\.|localhost$|\[?::1\]?$)/.test(new URL(base).hostname) } catch { return true }
}

/**
 * The Main's own address for the browser return: config `connections.redirectBase`
 * (e.g. the Tailnet HTTPS address), else the dashboard's real non-loopback
 * listener, else this machine only (then the owner pastes the address once).
 */
export function currentRedirectBase(): string {
    const configured = (globalThis as any).__novaState?.config?.connections?.redirectBase
    if (typeof configured === 'string' && /^https?:\/\/[^\s/]+\/?$/.test(configured)) return configured.replace(/\/$/, '')
    if (dashboardReturnBase) return dashboardReturnBase
    return `http://127.0.0.1:${Number(process.env.NOVA_DASHBOARD_PORT) || 3011}`
}

async function defaultGateway(deps: ConnectDeps): Promise<ConnectionGateway> {
    const { connectConnectionRecord, disconnectConnectionRecord } = await import('../mcp/mcp-runtime.js')
    return { connect: record => connectConnectionRecord(record, deps), disconnect: record => disconnectConnectionRecord(record) }
}

async function askLoginAgain(record: ConnectionRecord): Promise<void> {
    const { createConnectionThought } = await import('../core/thought-hub.js')
    createConnectionThought({
        kind: 'login', connectionId: record.id,
        title: `${record.title}: Anmeldung abgelaufen`,
        text: `Die Anmeldung bei ${record.title} gilt nicht mehr; bis zur neuen Anmeldung nutze ich ${record.title} nicht.`,
        proposal: 'Neu anmelden? (Ja öffnet die Anmeldung)',
        dedupeKey: `verbindung:login:${record.id}`,
    })
}

export function listConnectionRecords(deps: Pick<ConnectDeps, 'dataDir'> = {}): ConnectionRecord[] { return loadConnections(deps) }
