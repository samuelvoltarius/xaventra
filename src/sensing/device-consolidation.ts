/**
 * Paket L (2.85.11), Punkt 1 — ein Eintrag je echtem Gerät.
 *
 * `devices.json` bleibt das Roh-Protokoll der Beobachtungen (je Typ/Adresse/
 * Port ein Eintrag; daran hängen Fingerabdrücke, Owner-Entscheidungen,
 * Zugriffswege und Pairing). Daraus wird hier deterministisch die Geräteliste
 * gebaut, die der Owner sieht (`sensing/geraete.json`, Verbindungen →
 * Gefunden, Telegram):
 *
 * - Zusammengeführt wird über stabile Kennungen: Home-Assistant-Instanz-UUID
 *   (mDNS-TXT `uuid`), Hue-Bridge-ID (TXT `bridgeid` bzw. `/api/config`),
 *   UPnP-UDN, Matter-Instanzname (auch über IPv4 + IPv6), Tuya-Geräte-ID, MAC,
 *   dieselbe LAN-Adresse — und dieselbe Maschine über LAN + Tailnet
 *   (Tailscale meldet die LAN-Endpunkte seiner Peers, `host-aliases.json`).
 * - Ports/Dienste werden Eigenschaften des Geräts (`dienste`).
 * - Rauschen fällt heraus: Container-Bridges, der eigene Rechner, eigene
 *   Mesh-Knoten (dort zählt nur ein erkannter Dienst wie Home Assistant).
 *   Adressen nur mit offenen Ports ohne Kennung werden nur gezählt.
 * - Owner-Entscheidungen bleiben: eingerichtet/abgelehnt/aus stehen weiter an
 *   den Roh-Einträgen; das Gerät übernimmt sie. Die Migration liest nur.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { loadDevices, type DeviceCandidate, type DeviceRecord, type DeviceStatus, type DeviceType } from './device-registry.js'

export type GeraetArt = 'homeassistant' | 'hue' | 'tuya' | 'matter' | 'drucker' | 'tv' | 'dienst' | 'geraet'
export type VerbindenArt = 'homeassistant' | 'hue' | 'tuya' | 'matter'

export interface GeraetDienst { id: string; typ: DeviceType; port: number; via: DeviceRecord['via']; status: DeviceStatus; adresse: string }
export interface Geraet {
    /** `g-` + 10 hex of the identity key; contains no address. */
    id: string
    key: string
    art: GeraetArt
    titel: string
    /** Owner-readable origin, never an id: „Heimnetz“, „Heimnetz + Tailnet“. */
    ort: string
    adressen: string[]
    dienste: GeraetDienst[]
    /** Raw record the connect paths act on (fingerprints and approvals live there). */
    primaryId: string
    status: DeviceStatus
    verbinden: VerbindenArt | null
    lastSeenAt: string
}
export interface Konsolidierung {
    geraete: Geraet[]
    /** Raw entries dropped as noise (container bridges, own machine, own mesh nodes). */
    rauschen: number
    rauschGruende: Record<string, number>
    /** Addresses that only answered on a port (no identity) — counted, not listed. */
    ungeprueft: number
    ungeprueftEintraege: number
}
export interface KonsolidierungsKontext {
    eigeneAdressen?: string[]
    /** Own physical LAN subnets as CIDR strings (`a.b.c.d/n`). */
    eigeneNetze?: string[]
    meshAdressen?: string[]
    /** tailnet address → LAN address of the same machine. */
    aliase?: Record<string, string>
    /** Container bridge ranges (default 172.16.0.0/12 outside own subnets). */
    containerNetze?: string[]
}

const UNSPECIFIC: ReadonlySet<DeviceType> = new Set<DeviceType>(['networkservice', 'networkdevice'])
const PRINTERS: ReadonlySet<DeviceType> = new Set<DeviceType>(['moonraker', 'octoprint', 'prusalink', 'bambu'])

const ipInt = (ip: string) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0) >>> 0
function inCidr(ip: string, cidr: string): boolean {
    const [base, bitsText] = cidr.split('/')
    const bits = Number(bitsText)
    if (isIP(ip) !== 4 || isIP(base) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((ipInt(ip) & mask) >>>0) === ((ipInt(base) & mask) >>> 0)
}

const str = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const service = (r: Pick<DeviceRecord, 'evidence'>) => str(r.evidence?.service).toLowerCase()

/** A raw entry carries more than „a port answered“. */
export function isIdentified(r: Pick<DeviceRecord, 'type' | 'via' | 'evidence' | 'hardware'>): boolean {
    if (!UNSPECIFIC.has(r.type)) return true
    if (r.hardware?.identity || r.hardware?.certainty === 'confirmed' || r.hardware?.ecosystem) return true
    return Boolean(service(r) || str(r.evidence?.geraetekennung))
}

function noiseReason(r: Pick<DeviceRecord, 'type' | 'host' | 'via' | 'evidence' | 'hardware'>, ctx: KonsolidierungsKontext): string | null {
    const host = r.host
    const lan = ctx.aliase?.[host] || host
    const ownNet = (ip: string) => (ctx.eigeneNetze || []).some(cidr => inCidr(ip, cidr))
    if (isIP(host) === 4 && !ownNet(host) && (ctx.containerNetze || ['172.16.0.0/12']).some(cidr => inCidr(host, cidr))) return 'Container-Netz'
    if (isIdentified(r)) return null
    if ((ctx.eigeneAdressen || []).includes(host) || (ctx.eigeneAdressen || []).includes(lan)) return 'eigener Rechner'
    if ((ctx.meshAdressen || []).some(ip => ip === host || ip === lan || ctx.aliase?.[ip] === lan)) return 'eigener Mesh-Knoten'
    return null
}

/** Discovery: never record a candidate that would only be noise. */
export function isNoiseCandidate(c: Pick<DeviceCandidate, 'type' | 'host' | 'port' | 'via' | 'evidence' | 'hardware'>, ctx: KonsolidierungsKontext): boolean {
    return noiseReason({ ...c, evidence: (c.evidence || {}) as any }, ctx) !== null
}

function identityTokens(r: DeviceRecord, ctx: KonsolidierungsKontext): string[] {
    const tokens: string[] = []
    const uuid = str(r.evidence?.uuid).toLowerCase()
    if (r.type === 'homeassistant' && /^[a-f0-9-]{8,64}$/.test(uuid)) tokens.push(`ha:${uuid}`)
    const bridge = str(r.evidence?.bridgeid).toLowerCase()
    if (/^[a-f0-9]{16}$/.test(bridge)) tokens.push(`hue:${bridge}`)
    const h = r.hardware
    if (h?.identity) {
        const id = h.identity.toLowerCase()
        if (h.ecosystem === 'hue') tokens.push(`hue:${id}`)
        else if (h.ecosystem === 'tuya') tokens.push(`tuya:${id}`)
        else if (h.connector === 'matter-ip' || h.ecosystem === 'matter') tokens.push(`matter:${id}`)
        else if (id.startsWith('uuid:')) tokens.push(`upnp:${id}`)
        else if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(id)) tokens.push(`mac:${id}`)
        else tokens.push(`id:${h.ecosystem || h.connector || 'geraet'}:${id}`)
    }
    const udn = str(r.evidence?.geraetekennung).toLowerCase()
    if (udn.startsWith('uuid:')) tokens.push(`upnp:${udn}`)
    const mac = str(r.evidence?.mac).toLowerCase()
    if (/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) tokens.push(`mac:${mac}`)
    // Same machine: the LAN address (a tailnet address maps to its LAN twin).
    if (isIP(r.host) === 4) tokens.push(`host:${ctx.aliase?.[r.host] || r.host}`)
    return tokens
}

const KEY_RANK = ['ha:', 'hue:', 'tuya:', 'matter:', 'upnp:', 'mac:', 'id:', 'host:']
const rankOf = (token: string) => { const i = KEY_RANK.findIndex(prefix => token.startsWith(prefix)); return i < 0 ? KEY_RANK.length : i }

function isHue(r: DeviceRecord): boolean {
    return r.hardware?.ecosystem === 'hue' || service(r) === '_hue._tcp.local' || /\bhue\b/i.test(`${r.hardware?.label || ''} ${r.hardware?.manufacturer || ''} ${r.hardware?.model || ''}`)
}
function artOf(r: DeviceRecord): { art: GeraetArt; score: number } {
    if (r.type === 'homeassistant') return { art: 'homeassistant', score: 100 }
    if (isHue(r)) return { art: 'hue', score: 90 }
    if (r.hardware?.ecosystem === 'tuya') return { art: 'tuya', score: 80 }
    if (r.hardware?.connector === 'matter-ip' || ['_matter._tcp.local', '_matterc._udp.local'].includes(service(r))) return { art: 'matter', score: 70 }
    if (PRINTERS.has(r.type) || r.hardware?.kind === 'printer' || ['_ipp._tcp.local', '_ipps._tcp.local'].includes(service(r))) return { art: 'drucker', score: 60 }
    if (r.hardware?.kind === 'tv' || ['_googlecast._tcp.local', '_airplay._tcp.local'].includes(service(r))) return { art: 'tv', score: 50 }
    if (!UNSPECIFIC.has(r.type)) return { art: 'dienst', score: 40 }
    if (r.hardware?.identity) return { art: 'geraet', score: 30 }
    if (service(r)) return { art: 'geraet', score: 20 }
    return { art: 'geraet', score: 0 }
}

const ART_TITLE: Record<GeraetArt, string> = {
    homeassistant: 'Home Assistant', hue: 'Hue Bridge', tuya: 'Tuya-Gerät', matter: 'Matter-Gerät', drucker: 'Drucker', tv: 'TV/Medien', dienst: 'Dienst', geraet: 'Gerät',
}
const SERVICE_TITLE: Partial<Record<DeviceType, string>> = { moonraker: 'Drucker (Klipper)', octoprint: 'Drucker (OctoPrint)', prusalink: 'Drucker (PrusaLink)', bambu: 'Drucker (Bambu)', n8n: 'n8n', paperless: 'Paperless-ngx', immich: 'Immich', jellyfin: 'Jellyfin', nextcloud: 'Nextcloud' }

/** Owner-readable names never carry hashes or addresses. */
const readable = (value: string) => value.replace(/\b[a-f0-9]{12,}\b/gi, '').replace(/\buuid:\S+/gi, '').replace(/\s+-\s*[A-F0-9]{4,}$/i, '').replace(/\s{2,}/g, ' ').trim()

function titleOf(art: GeraetArt, primary: DeviceRecord, members: DeviceRecord[]): string {
    if (art === 'homeassistant' || art === 'hue' || art === 'tuya' || art === 'matter') return ART_TITLE[art]
    if (SERVICE_TITLE[primary.type]) return SERVICE_TITLE[primary.type]!
    const named = [primary, ...members].map(m => readable(m.hardware?.label && m.hardware.certainty !== 'unknown' ? m.hardware.label : m.via === 'mdns' ? m.name : '')).find(Boolean)
    return named ? named.slice(0, 60) : ART_TITLE[art]
}

/** The raw entry a connect path acts on. */
function primaryFor(art: GeraetArt, members: DeviceRecord[], ctx: KonsolidierungsKontext): DeviceRecord {
    const lanFirst = (a: DeviceRecord, b: DeviceRecord) => Number(Boolean(ctx.aliase?.[a.host])) - Number(Boolean(ctx.aliase?.[b.host])) || Number(isIP(a.host) !== 4) - Number(isIP(b.host) !== 4)
    const pick = (filter: (r: DeviceRecord) => boolean, score: (r: DeviceRecord) => number) =>
        members.filter(filter).sort((a, b) => score(b) - score(a) || lanFirst(a, b) || a.id.localeCompare(b.id))[0]
    if (art === 'homeassistant') return pick(r => r.type === 'homeassistant', r => (r.via === 'http' ? 2 : 0) + (r.status === 'eingerichtet' ? 4 : 0))!
    if (art === 'hue') return pick(isHue, r => (r.hardware?.access === 'hue-pairing-v1' ? 8 : 0) + (r.hardware?.connector === 'hue-readonly' ? 4 : 0) + (r.port === 80 ? 2 : 0) + (r.via === 'mdns' ? 1 : 0))!
    if (art === 'tuya') return pick(r => r.hardware?.ecosystem === 'tuya', r => r.hardware?.connector ? 1 : 0)!
    if (art === 'matter') return pick(r => artOf(r).art === 'matter', r => r.hardware?.connector === 'matter-ip' ? 1 : 0)!
    return pick(() => true, r => artOf(r).score + (r.status === 'eingerichtet' ? 1 : 0))!
}

export function consolidateDevices(records: DeviceRecord[], ctx: KonsolidierungsKontext = {}): Konsolidierung {
    const rauschGruende: Record<string, number> = {}
    let rauschen = 0
    const kept: DeviceRecord[] = []
    for (const r of records) {
        const reason = noiseReason(r, ctx)
        if (reason) { rauschen++; rauschGruende[reason] = (rauschGruende[reason] || 0) + 1 } else kept.push(r)
    }
    // Union-find over shared identity tokens.
    const parent = kept.map((_, i) => i)
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
    const owner = new Map<string, number>()
    const tokens = kept.map(r => identityTokens(r, ctx))
    tokens.forEach((list, i) => {
        for (const token of list) {
            const j = owner.get(token)
            if (j === undefined) owner.set(token, i)
            else parent[find(i)] = find(j)
        }
    })
    const groups = new Map<number, number[]>()
    kept.forEach((_, i) => { const root = find(i); groups.set(root, [...(groups.get(root) || []), i]) })

    const geraete: Geraet[] = []
    let ungeprueft = 0, ungeprueftEintraege = 0
    for (const indices of groups.values()) {
        const members = indices.map(i => kept[i])
        const ownerSetUp = members.some(m => m.status === 'eingerichtet')
        if (!members.some(isIdentified) && !ownerSetUp) { ungeprueft++; ungeprueftEintraege += members.length; continue }
        const best = members.map(artOf).sort((a, b) => b.score - a.score)[0]
        const primary = primaryFor(best.art, members, ctx)
        const groupTokens = [...new Set(indices.flatMap(i => tokens[i]))].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
        const key = groupTokens[0] || `rec:${primary.id}`
        const same = members.filter(m => artOf(m).art === best.art)
        const status: DeviceStatus = ownerSetUp ? 'eingerichtet'
            : same.some(m => m.status === 'abgelehnt') || primary.status === 'abgelehnt' ? 'abgelehnt'
            : same.some(m => m.status === 'aus') || primary.status === 'aus' ? 'aus' : 'gefunden'
        const adressen = [...new Set(members.map(m => m.host))].sort()
        const tailnet = adressen.some(ip => Boolean(ctx.aliase?.[ip]))
        geraete.push({
            id: `g-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`, key, art: best.art, titel: titleOf(best.art, primary, members),
            ort: tailnet ? 'Heimnetz + Tailnet' : 'Heimnetz', adressen,
            dienste: members.map(m => ({ id: m.id, typ: m.type, port: m.port, via: m.via, status: m.status, adresse: m.host })).sort((a, b) => a.adresse.localeCompare(b.adresse) || a.port - b.port || a.id.localeCompare(b.id)),
            primaryId: primary.id, status,
            verbinden: status === 'gefunden' && ['homeassistant', 'hue', 'tuya', 'matter'].includes(best.art) ? best.art as VerbindenArt : null,
            lastSeenAt: members.map(m => m.lastSeenAt).sort().at(-1) || primary.lastSeenAt,
        })
    }
    const order: Record<GeraetArt, number> = { homeassistant: 0, hue: 1, tuya: 2, matter: 3, drucker: 4, tv: 5, dienst: 6, geraet: 7 }
    geraete.sort((a, b) => order[a.art] - order[b.art] || a.titel.localeCompare(b.titel) || a.id.localeCompare(b.id))
    return { geraete, rauschen, rauschGruende, ungeprueft, ungeprueftEintraege }
}

// ---------------------------------------------------------------------------
// persistence: host aliases (tailnet ↔ LAN) and the consolidated registry
// ---------------------------------------------------------------------------

const aliasFile = (dataDir: string) => join(dataDir, 'sensing', 'host-aliases.json')
const registryFile = (dataDir: string) => join(dataDir, 'sensing', 'geraete.json')

export function readHostAliases(dataDir: string): Record<string, string> {
    try {
        const raw = existsSync(aliasFile(dataDir)) ? JSON.parse(readFileSync(aliasFile(dataDir), 'utf8'))?.aliases : null
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        return Object.fromEntries(Object.entries(raw).filter(([k, v]) => isIP(k) === 4 && typeof v === 'string' && isIP(v) === 4).slice(0, 256)) as Record<string, string>
    } catch { return {} }
}

/** Merges new aliases (latest observation wins); never stores names or keys. */
export function recordHostAliases(dataDir: string, aliases: Record<string, string>): void {
    const clean = Object.entries(aliases || {}).filter(([k, v]) => isIP(k) === 4 && isIP(v) === 4)
    if (!clean.length) return
    const merged = { ...readHostAliases(dataDir), ...Object.fromEntries(clean) }
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(aliasFile(dataDir), { version: 1, aliases: Object.fromEntries(Object.entries(merged).slice(-256)) })
}

/** Production context: own interfaces, own mesh nodes, stored aliases. */
export async function defaultConsolidationContext(dataDir: string, interfaces?: import('./net-scope.js').InterfaceMap): Promise<KonsolidierungsKontext> {
    const ctx: KonsolidierungsKontext = { aliase: readHostAliases(dataDir) }
    try {
        const { ownSubnets } = await import('./net-scope.js')
        const scope = ownSubnets(interfaces)
        ctx.eigeneAdressen = scope.own
        ctx.eigeneNetze = scope.subnets.map(c => `${[c.base >>> 24, (c.base >>> 16) & 255, (c.base >>> 8) & 255, c.base & 255].join('.')}/${c.bits}`)
    } catch { /* best effort */ }
    try {
        const { loadMeshData } = await import('../mesh/mesh-registry.js')
        ctx.meshAdressen = loadMeshData().nodes.map(node => String(node.ip || '')).filter(ip => isIP(ip) === 4).slice(0, 64)
    } catch { /* no mesh */ }
    return ctx
}

/**
 * Builds `sensing/geraete.json` from the raw observations. Reads `devices.json`
 * only — every raw entry, owner decision, fingerprint and pairing state stays
 * exactly where it was. Idempotent.
 */
export function migrateDeviceRegistry(dataDir: string, ctx: KonsolidierungsKontext = {}): Konsolidierung {
    const result = consolidateDevices(loadDevices(dataDir), { ...ctx, aliase: { ...readHostAliases(dataDir), ...(ctx.aliase || {}) } })
    mkdirSync(join(dataDir, 'sensing'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(registryFile(dataDir), { version: 1, ...result })
    return result
}

/** Consolidated devices for views (computed fresh; the file is the persisted copy). */
export async function loadConsolidatedDevices(dataDir: string, ctx?: KonsolidierungsKontext): Promise<Konsolidierung> {
    return consolidateDevices(loadDevices(dataDir), ctx || await defaultConsolidationContext(dataDir))
}

/** `/geraete` and the Telegram device view: one line per real device, no ids or addresses. */
export function formatGeraete(k: Konsolidierung): string {
    const icon: Record<DeviceStatus, string> = { gefunden: '🆕', eingerichtet: '✅', abgelehnt: '🚫', aus: '⏸️' }
    const state: Record<DeviceStatus, string> = { gefunden: 'gefunden', eingerichtet: 'eingerichtet', abgelehnt: 'ausgeblendet', aus: 'Überwachung aus' }
    if (!k.geraete.length) return 'Noch keine Geräte erkannt. Die Suche im eigenen Netz läuft von selbst; /geraete suchen startet sie sofort.'
    const lines = [`📱 ${k.geraete.length} ${k.geraete.length === 1 ? 'Gerät' : 'Geräte'} (eins je echtem Gerät)`]
    for (const g of k.geraete) lines.push(`${icon[g.status]} ${g.titel} — ${state[g.status]}${g.verbinden ? ' · Verbinden-Knopf in der Geräte-Nachricht' : ''}${g.dienste.length > 1 ? ` · ${g.dienste.length} Dienste` : ''}`)
    const extra = [k.ungeprueft ? `${k.ungeprueft} ${k.ungeprueft === 1 ? 'Adresse' : 'Adressen'} nur mit offenen Ports (ohne Kennung, nicht einzeln gelistet)` : '', k.rauschen ? `${k.rauschen} Einträge Rauschen ausgeblendet (Container, eigener Rechner, eigene Knoten)` : ''].filter(Boolean)
    if (extra.length) lines.push('', `Dazu ${extra.join('; ')}.`)
    return lines.join('\n')
}
