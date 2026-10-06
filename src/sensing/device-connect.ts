/**
 * Paket L (2.85.11), Punkte 2 + 3 — je echtem Gerät genau EIN „Verbinden“.
 *
 * After every discovery the consolidated devices (device-consolidation.ts)
 * that can be connected get ONE card each (Tuya: a lokal/Cloud pair), all in
 * the bundled device message (card-bundle.ts, `buendel: 'geraete'`). The card
 * only carries the raw entry id; on „Ja“ the code re-checks the device and
 * runs the EXISTING flows:
 *
 * - Home Assistant: fresh `/manifest.json` check, then `approveSensingDevice`
 *   → Paket-A connect flow → HA's own login (token only in the secrets store).
 * - Hue: the card says „Taste an der Bridge drücken, dann Ja“. Ja = fresh
 *   `/api/config` identity check, local way chosen, owner approval, bounded
 *   pairing window, and one pairing attempt right away (only the local API key
 *   is fetched; then the lamps are read). A configuration change, NOT switching.
 * - Tuya: „Lokal“ or „Cloud“ chooses the way, then the existing approval; the
 *   private key/access is entered in the desktop (never in the chat).
 * - Matter: local way + approval; the pairing code is entered in the desktop.
 *
 * Switching stays a separate card per action (action policy unchanged).
 * „Nein“ hides every endpoint of the device. An unanswered card gets one
 * reminder, then goes to the report and is not re-asked for 14 days.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConnections } from '../connections/connection-store.js'
import { createApprovalCard, listApprovalCards, type ApprovalCard, type CardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import { consolidateDevices, defaultConsolidationContext, migrateDeviceRegistry, type Geraet, type KonsolidierungsKontext } from './device-consolidation.js'
import { deviceId, loadDevices, recordCandidates, setDeviceStatus, type Approver, type DeviceRecord } from './device-registry.js'
import { identifyHardware } from './hardware-recognition.js'
import { identifyHttp, type HttpProbeResult } from './discovery.js'
import { approvedSmartRoute, chooseSmartRoute, type SmartRoute } from './smart-device-route.js'
import { hueKey } from './direct-smart-devices.js'

export const DEVICE_CONNECT_KIND = 'geraet-verbinden'
export const DEVICE_BUNDLE = 'geraete'
const CARD_TTL_MS = 72 * 60 * 60_000
const QUIET_AFTER_EXPIRY_MS = 14 * 24 * 60 * 60_000
const OFFER_MAX_AGE_MS = 30 * 24 * 60 * 60_000
const REF = /^(dev-[a-f0-9]{10})(?::(local|cloud))?$/

export interface DeviceConnectDeps {
    dataDir: string
    ctx?: KonsolidierungsKontext
    cardOpts?: CardStoreOptions
    now?: () => number
    /** Scope gate before any probe (default: own private subnets). */
    allowTarget?: (host: string) => boolean
    httpProbe?: (url: string, timeoutMs: number) => Promise<HttpProbeResult | null>
    /** The existing owner approval path (default: sensing runtime `approveSensingDevice`). */
    approve?: (id: string, approver: Approver) => Promise<{ ok: boolean; message: string }>
    /** One immediate Hue pairing + lamp read (default: direct-smart-devices). */
    pairNow?: (id: string) => Promise<{ status: string; lampen: number }>
}

const nowOf = (deps: DeviceConnectDeps) => (deps.now || Date.now)()

async function contextOf(deps: DeviceConnectDeps): Promise<KonsolidierungsKontext> {
    return deps.ctx || defaultConsolidationContext(deps.dataDir)
}

/** Is the device already connected through its way? */
export function isDeviceConnected(dataDir: string, geraet: Geraet, records: DeviceRecord[] = loadDevices(dataDir)): boolean {
    const members = records.filter(r => geraet.dienste.some(d => d.id === r.id))
    if (geraet.art === 'homeassistant') {
        try { return loadConnections({ dataDir }).some(c => c.connectorId === 'home-assistant' && c.status === 'verbunden') } catch { return false }
    }
    if (geraet.art === 'hue') return members.some(r => Boolean(hueKey(dataDir, r.id)))
    return members.some(r => r.status === 'eingerichtet' && Boolean(approvedSmartRoute(dataDir, r)))
}

function kurzOf(g: Geraet): string {
    const hint: Record<string, string> = {
        homeassistant: 'dann einmal bei Home Assistant anmelden',
        hue: 'erst Taste an der Bridge drücken, dann Ja',
        tuya: 'lokal oder über die Hersteller-Cloud?',
        matter: 'Kopplungscode danach in der App eingeben',
    }
    return `${g.titel} · ${hint[g.verbinden || ''] || g.ort}`
}

function cardInputs(g: Geraet): Array<Parameters<typeof createApprovalCard>[0]> {
    const base = { art: DEVICE_CONNECT_KIND, buendel: DEVICE_BUNDLE, kurz: kurzOf(g), ablaufMs: CARD_TTL_MS, quelle: 'geraete', gruppe: g.id }
    const beleg = `${g.titel} im ${g.ort} gefunden (${g.dienste.length} ${g.dienste.length === 1 ? 'Dienst' : 'Dienste'}). Erst nach dem Verbinden lese ich, was dahinter hängt; geschaltet wird nur über eine eigene Karte.`
    if (g.verbinden === 'homeassistant') return [{ ...base, titel: 'Home Assistant verbinden?', beleg, aktion: { kind: DEVICE_CONNECT_KIND, ref: g.primaryId },
        vorschlag: 'Ja = Adresse übernehmen und die Anmeldeseite von Home Assistant öffnen. Danach lese ich Lampen, Steckdosen und Sensoren; nichts wird geschaltet.', dedupeKey: `geraet:${g.key}` }]
    if (g.verbinden === 'hue') return [{ ...base, titel: 'Hue Bridge koppeln?', beleg, aktion: { kind: DEVICE_CONNECT_KIND, ref: g.primaryId },
        vorschlag: 'Erst die runde Taste an der Hue Bridge drücken, dann innerhalb von 30 Sekunden Ja. Ich hole nur den lokalen Schlüssel und lese die Lampen; nichts wird geschaltet.', dedupeKey: `geraet:${g.key}` }]
    if (g.verbinden === 'tuya') return (['local', 'cloud'] as const).map(route => ({ ...base, titel: `Tuya-Gerät ${route === 'local' ? 'lokal' : 'über die Hersteller-Cloud'} verbinden?`, beleg,
        aktion: { kind: DEVICE_CONNECT_KIND, ref: `${g.primaryId}:${route}` }, knopf: route === 'local' ? 'Lokal' : 'Cloud',
        vorschlag: route === 'local' ? 'Lokal: den privaten Geräteschlüssel trägst du danach in der App unter Verbindungen ein. Nur lesen, nichts schalten.' : 'Cloud: den Herstellerzugang trägst du danach in der App unter Verbindungen ein. Nur lesen, nichts schalten.',
        dedupeKey: `geraet:${g.key}:${route}` }))
    if (g.verbinden === 'matter') return [{ ...base, titel: 'Matter-Gerät koppeln?', beleg, aktion: { kind: DEVICE_CONNECT_KIND, ref: g.primaryId },
        vorschlag: 'Ja = Kopplung vorbereiten. Den Kopplungscode gibst du danach in der App unter Verbindungen ein (nicht im Chat). Nichts wird geschaltet.', dedupeKey: `geraet:${g.key}` }]
    return []
}

/** Creates the missing device questions (one per device). Returns how many cards were created. */
export async function offerDeviceConnections(deps: DeviceConnectDeps): Promise<{ created: number; geraete: Geraet[] }> {
    const ctx = await contextOf(deps)
    const records = loadDevices(deps.dataDir)
    const { geraete } = consolidateDevices(records, ctx)
    const opts = deps.cardOpts || { dataDir: deps.dataDir }
    const now = nowOf(deps)
    const cards = listApprovalCards(opts)
    let created = 0
    const offered: Geraet[] = []
    for (const g of geraete) {
        if (!g.verbinden || isDeviceConnected(deps.dataDir, g, records)) continue
        const seen = Date.parse(g.lastSeenAt)
        if (!Number.isFinite(seen) || now - seen > OFFER_MAX_AGE_MS) continue
        const inputs = cardInputs(g)
        const quiet = cards.some(card => inputs.some(input => card.dedupeKey === input.dedupeKey)
            && (card.status === 'nein' || (card.status === 'abgelaufen' && now - Date.parse(card.expiresAt) < QUIET_AFTER_EXPIRY_MS)))
        if (quiet) continue
        for (const input of inputs) {
            const result = createApprovalCard(input, opts)
            if (result.ok && result.created) created++
        }
        offered.push(g)
    }
    return { created, geraete: offered }
}

/**
 * The owner pressed „Verbinden“ on one device (desktop „Verbindungen → Gefunden“):
 * create (or return the open) connect card for exactly this device.
 */
export async function offerDeviceConnection(deps: DeviceConnectDeps, primaryId: string, weg?: 'local' | 'cloud'): Promise<{ ok: boolean; message: string; cardId?: string }> {
    const { geraet } = findDevice(deps.dataDir, primaryId, await contextOf(deps))
    if (!geraet || !geraet.verbinden) return { ok: false, message: 'Für dieses Gerät gibt es keinen Verbindungsweg.' }
    if (isDeviceConnected(deps.dataDir, geraet)) return { ok: false, message: `${geraet.titel} ist schon verbunden.` }
    const inputs = cardInputs(geraet).filter(input => !weg || input.aktion.ref.endsWith(`:${weg}`) || !input.aktion.ref.includes(':'))
    let cardId: string | undefined
    for (const input of inputs) {
        const result = createApprovalCard(input, deps.cardOpts || { dataDir: deps.dataDir })
        if (result.ok && !cardId) cardId = result.card.id
    }
    return cardId ? { ok: true, cardId, message: `Karte „${inputs[0].titel}“ — Ja oder Nein direkt hier oder in Telegram.` } : { ok: false, message: 'Keine Karte möglich.' }
}

function findDevice(dataDir: string, id: string, ctx: KonsolidierungsKontext): { record?: DeviceRecord; geraet?: Geraet; records: DeviceRecord[] } {
    const records = loadDevices(dataDir)
    const record = records.find(r => r.id === id)
    const geraet = consolidateDevices(records, ctx).geraete.find(g => g.dienste.some(d => d.id === id))
    return { record, geraet, records }
}

async function defaultScope(host: string): Promise<boolean> {
    const { ownSubnets, scanTargetAllowed } = await import('./net-scope.js')
    return scanTargetAllowed(host, ownSubnets()).allowed
}
async function probe(deps: DeviceConnectDeps, url: string): Promise<HttpProbeResult | null> {
    if (deps.httpProbe) return deps.httpProbe(url, 1500)
    const { realHttpProbe } = await import('./discovery.js')
    return realHttpProbe(url, 1500)
}
async function approveVia(deps: DeviceConnectDeps, id: string, approver: Approver): Promise<{ ok: boolean; message: string }> {
    if (deps.approve) return deps.approve(id, approver)
    const { approveSensingDevice } = await import('./runtime.js')
    return approveSensingDevice(id, approver)
}
async function pairVia(deps: DeviceConnectDeps, id: string): Promise<{ status: string; lampen: number }> {
    if (deps.pairNow) return deps.pairNow(id)
    const { refreshDirectInventory } = await import('./direct-smart-devices.js')
    const rows = await refreshDirectInventory(deps.dataDir, AbortSignal.timeout(10_000), { only: id })
    const row = rows.find(item => item.deviceId === id)
    return { status: row?.status || 'unavailable', lampen: row?.functions.filter(f => f.kind === 'light').length || 0 }
}

async function connectHue(deps: DeviceConnectDeps, record: DeviceRecord, approver: Approver): Promise<{ ok: boolean; message: string }> {
    const allow = deps.allowTarget ? deps.allowTarget(record.host) : await defaultScope(record.host)
    if (!allow) return { ok: false, message: 'Die Bridge liegt nicht mehr im eigenen Netz. Nichts gekoppelt.' }
    const identity = identifyHardware(await probe(deps, `http://${record.host}:80/api/config`), 'hue-config', nowOf(deps))
    if (!identity) return { ok: false, message: 'Die Bridge hat sich nicht als Hue Bridge bestätigt. Nichts gekoppelt; bitte später erneut versuchen.' }
    recordCandidates(deps.dataDir, [{ type: 'networkservice', host: record.host, port: 80, via: 'http', name: 'Hue Bridge', hardware: identity, evidence: { quelle: 'GET /api/config', bridgeid: identity.identity } }], nowOf(deps))
    const endpointId = deviceId({ type: 'networkservice', host: record.host, port: 80 })
    const chosen = chooseSmartRoute(deps.dataDir, endpointId, 'local', approver, nowOf(deps))
    if (!chosen.ok) return { ok: false, message: 'Lokaler Weg konnte nicht gewählt werden. Nichts gekoppelt.' }
    const approved = await approveVia(deps, endpointId, approver)
    if (!approved.ok) return { ok: false, message: `Nicht gekoppelt: ${approved.message}` }
    const paired = await pairVia(deps, endpointId)
    if (paired.status === 'ok') return { ok: true, message: `Hue Bridge gekoppelt: ${paired.lampen} ${paired.lampen === 1 ? 'Lampe' : 'Lampen'} gelesen. Geschaltet wird nur über eine eigene Karte.` }
    if (paired.status === 'pairing') return { ok: true, message: 'Kopplung freigegeben, die Taste wurde noch nicht erkannt. Drück sie jetzt — ich versuche es zwei Minuten lang weiter und melde die Lampen.' }
    return { ok: true, message: 'Kopplung freigegeben; die Bridge hat noch nicht geantwortet. Ich versuche es zwei Minuten lang weiter.' }
}

export async function connectDevice(deps: DeviceConnectDeps, ref: string, approver: Approver): Promise<{ ok: boolean; message: string }> {
    const match = REF.exec(String(ref || ''))
    if (!match) return { ok: false, message: 'Unbekanntes Gerät — nichts verbunden.' }
    const [, id, route] = match
    const { record, geraet } = findDevice(deps.dataDir, id, await contextOf(deps))
    if (!record || !geraet) return { ok: false, message: 'Das Gerät ist nicht mehr bekannt — nichts verbunden.' }
    if (['abgelehnt', 'aus'].includes(geraet.status)) return { ok: false, message: 'Das Gerät ist ausgeblendet — nichts verbunden.' }
    if (geraet.art === 'homeassistant') {
        const allow = deps.allowTarget ? deps.allowTarget(record.host) : await defaultScope(record.host)
        if (!allow || identifyHttp(record.port, '/manifest.json', await probe(deps, `http://${record.host}:${record.port}/manifest.json`)) !== 'homeassistant') {
            return { ok: false, message: 'Home Assistant antwortet gerade nicht an dieser Adresse. Nichts verbunden; bitte später erneut.' }
        }
        recordCandidates(deps.dataDir, [{ type: 'homeassistant', host: record.host, port: record.port, via: 'http' }], nowOf(deps))
        return approveVia(deps, id, approver)
    }
    if (geraet.art === 'hue') return connectHue(deps, record, approver)
    if (geraet.art === 'tuya' || geraet.art === 'matter') {
        const way: SmartRoute = geraet.art === 'tuya' && route === 'cloud' ? 'cloud' : 'local'
        const chosen = chooseSmartRoute(deps.dataDir, id, way, approver, nowOf(deps))
        if (!chosen.ok) return { ok: false, message: 'Der Fund ist veraltet; bei der nächsten Suche frage ich neu. Nichts verbunden.' }
        const approved = await approveVia(deps, id, approver)
        return approved.ok
            ? { ok: true, message: geraet.art === 'matter' ? 'Kopplung vorbereitet. Den Kopplungscode bitte in der App unter Verbindungen eingeben (nicht im Chat). Nichts geschaltet.'
                : `${way === 'local' ? 'Lokaler' : 'Cloud-'} Weg freigegeben. Den ${way === 'local' ? 'Geräteschlüssel' : 'Herstellerzugang'} bitte in der App unter Verbindungen eintragen (nicht im Chat). Nichts geschaltet.` }
            : approved
    }
    return { ok: false, message: 'Für dieses Gerät gibt es keinen Verbindungsweg.' }
}

/** Hide the device: every raw endpoint becomes `abgelehnt` (owner decision, never overwritten). */
export async function declineDevice(deps: DeviceConnectDeps, ref: string, approver: Approver): Promise<{ ok: boolean; message: string }> {
    const match = REF.exec(String(ref || ''))
    if (!match) return { ok: false, message: 'Unbekanntes Gerät.' }
    const { geraet } = findDevice(deps.dataDir, match[1], await contextOf(deps))
    for (const id of geraet ? geraet.dienste.map(d => d.id) : [match[1]]) setDeviceStatus(deps.dataDir, id, 'abgelehnt', approver)
    return { ok: true, message: 'Nicht verbunden; ich frage zu diesem Gerät nicht mehr.' }
}

export function createDeviceConnectExecutor(deps: DeviceConnectDeps | (() => DeviceConnectDeps)): CardExecutor {
    const get = () => typeof deps === 'function' ? deps() : deps
    const approverOf = (decidedBy: string): Approver => ({ principalId: decidedBy, permission: 'owner' })
    return {
        kind: DEVICE_CONNECT_KIND,
        impact: 'intern',
        allowAlways: () => false,
        async execute(card: ApprovalCard, _answer, ctx) { return connectDevice(get(), card.aktion.ref, approverOf(ctx.decidedBy)) },
        async reject(card: ApprovalCard, ctx) { return declineDevice(get(), card.aktion.ref, approverOf(ctx.decidedBy)) },
        isStillOpen(card: ApprovalCard) {
            const d = get()
            const match = REF.exec(card.aktion.ref)
            if (!match) return false
            const records = loadDevices(d.dataDir)
            const record = records.find(r => r.id === match[1])
            if (!record || ['abgelehnt', 'aus'].includes(record.status)) return false
            // a lokal/Cloud pair: once a way was chosen for this device, the other button closes
            if (match[2]) {
                try { const routes = readRoutes(d.dataDir); const chosen = routes[match[1]]; if (chosen && chosen.route !== match[2]) return false } catch { /* keep open */ }
            }
            return true
        },
    }
}

function readRoutes(dataDir: string): Record<string, { route: string }> {
    try { return JSON.parse(readFileSync(join(dataDir, 'sensing', 'smart-routes.json'), 'utf8'))?.choices || {} } catch { return {} }
}

/** Production deps (Main only). */
export async function productionDeviceConnectDeps(): Promise<DeviceConnectDeps> {
    const { getNovaDataDir } = await import('../core/data-root.js')
    return { dataDir: getNovaDataDir() }
}

/** After a discovery: persist the consolidated registry and offer the missing connections. */
export async function afterDiscovery(dataDir: string): Promise<{ created: number }> {
    const ctx = await defaultConsolidationContext(dataDir)
    migrateDeviceRegistry(dataDir, ctx)
    const { created } = await offerDeviceConnections({ dataDir, ctx })
    return { created }
}
