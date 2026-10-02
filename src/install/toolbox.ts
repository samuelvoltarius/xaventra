/**
 * 2.85 Paket D — Werkzeugkasten: "welche Programme würden Xaventra stärker machen?"
 *
 * A read model over existing data only, deterministic, no network:
 * - release catalogs (software-candidates.ts → install-catalog.ts),
 * - node profiles (own + signed peers, the same nodes the Software-Scout rates),
 * - fit per node from `assessCandidate` (passt / passt nicht + reason),
 * - recorded need (software-demand.ts) → "empfohlen, weil gebraucht",
 * - freshness from the cache of software-freshness.ts (never a search on page view),
 * - the install queue (installed through us, open proposal, rollback possible),
 * - optionally the last Paket-C scan (mesh/ai-scanner getLastScanResult) for "läuft".
 *
 * The buttons it describes go only into the existing paths (toolbox-actions.ts):
 * install queue → install card → signed ticket, and rollback card → rollbackQueuedInstall.
 */
import { findCatalogEntry, getInstallCatalog, type InstallCatalog } from './install-catalog.js'
import type { InstallProposal } from './install-queue.js'
import type { CapabilityDemand } from './software-demand.js'
import { candidateAgeMonths, MODEL_MAX_AGE_MONTHS, type FreshnessRecord } from './software-freshness.js'
import { assessCandidate, STALE_PEER_MS, type FitResult, type ScoutNode } from './software-scout.js'
import {
    CAPABILITY_LABEL, SOFTWARE_CAPABILITIES, getSoftwareCandidates,
    type SoftwareCandidate, type SoftwareCandidateCatalog, type SoftwareCapability,
} from './software-candidates.js'

export type ToolboxStatus = 'laeuft' | 'installiert' | 'abgedeckt' | 'passt' | 'passt-nicht'
export type ToolboxButton = { art: 'installieren'; katalogId: string; knoten: string } | { art: 'entfernen'; queueId: string }

export interface ToolboxEntry {
    id: string
    name: string
    /** One plain sentence: what it brings. */
    nutzen: string
    /** The longer, technical reason from the candidate catalog. */
    detail: string
    faehigkeit: SoftwareCapability
    status: ToolboxStatus
    statusText: string
    /** Recommended node (where it runs, is installed or fits best). */
    knoten: string | null
    empfohlen: boolean
    bedarf: string[]
    aktualitaet: { status: 'aktuell' | 'nachfolger' | 'ungeprueft' | 'kein-modell'; stand: string | null; text: string }
    katalogId: string | null
    groesseMb: number | null
    knopf: ToolboxButton | null
    /** Why there is no button, or what happens next — plain words. */
    hinweis: string
    warteschlange: { id: string; status: string } | null
}
export interface ToolboxGroup { faehigkeit: SoftwareCapability; titel: string; eintraege: ToolboxEntry[] }
export interface Toolbox {
    generatedAt: string
    knoten: Array<{ id: string; bewertet: boolean }>
    gruppen: ToolboxGroup[]
    hinweis: string
}

/** Running services from the Paket-C scan (only the fields used here). */
export interface ToolboxScanService { name: string; provider?: string; status: 'running' | 'installed' | 'stopped'; sourceNode?: string; host?: string }

export interface ToolboxInput {
    nodes: readonly ScoutNode[]
    demand?: ReadonlyMap<SoftwareCapability, CapabilityDemand>
    freshness?: Readonly<Record<string, FreshnessRecord>>
    queue?: readonly InstallProposal[]
    scan?: { services: readonly ToolboxScanService[] } | null
    candidates?: SoftwareCandidateCatalog
    installCatalog?: InstallCatalog
    now?: number
}

export const FAEHIGKEIT_TITEL: Readonly<Record<SoftwareCapability, string>> = Object.freeze({
    stt: 'Zuhören', tts: 'Vorlesen', embedding: 'Erinnern', browser: 'Im Web arbeiten', media: 'Audio und Video',
    vision: 'Sehen und Lesen', desktop: 'Bildschirm-Arbeitsplatz', llm: 'Denken ohne Internet', search: 'Im Internet suchen',
})

/** Plain sentence per capability when a candidate has no own `nutzen`. */
const NUTZEN_JE_FAEHIGKEIT: Readonly<Record<SoftwareCapability, string>> = Object.freeze({
    stt: 'Versteht dann deine Sprachnachrichten.', tts: 'Kann dir dann Antworten vorlesen.', embedding: 'Findet dann Erinnerungen besser wieder.',
    browser: 'Kann dann selbst Webseiten öffnen und lesen.', media: 'Kann dann Audio und Video umwandeln.', vision: 'Kann dann Bilder ansehen.',
    desktop: 'Bekommt dann einen Bildschirm-Arbeitsplatz.', llm: 'Kann dann auch ohne Internet antworten.', search: 'Kann dann selbst im Internet suchen.',
})

const OPEN = new Set(['queued', 'suggested', 'running'])
const isFresh = (node: ScoutNode, now: number) => node.local || (typeof node.lastSeen === 'number' && now - node.lastSeen <= STALE_PEER_MS)
const lower = (value: unknown) => String(value ?? '').toLowerCase()
const day = (ms: number) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` }

/** "läuft": a matching running service in the node profile or in the Paket-C scan. */
function runningOn(candidate: SoftwareCandidate, nodes: readonly ScoutNode[], scan: ToolboxInput['scan']): string | null {
    const names = (candidate.detect?.services || []).map(lower)
    if (!names.length) return null
    for (const node of nodes) {
        if ((node.profile.services || []).some(service => service.status === 'running' && names.includes(lower(service.name)))) return node.nodeId
    }
    const hit = (scan?.services || []).find(service => service.status === 'running' && (names.includes(lower(service.name)) || names.includes(lower(service.provider))))
    return hit ? String(hit.sourceNode || hit.host || 'im Netz').slice(0, 80) : null
}

/** "installiert": a detected tool/service in a profile. */
function installedOn(candidate: SoftwareCandidate, nodes: readonly ScoutNode[]): string | null {
    for (const node of nodes) {
        const tools = node.profile.tools || []
        if ((candidate.detect?.tools || []).some(tool => tools.includes(tool))) return node.nodeId
        if ((node.profile.services || []).some(service => (candidate.detect?.services || []).map(lower).includes(lower(service.name)))) return node.nodeId
    }
    return null
}

function freshnessOf(candidate: SoftwareCandidate, record: FreshnessRecord | undefined, now: number): ToolboxEntry['aktualitaet'] {
    if (candidate.kind !== 'model') return { status: 'kein-modell', stand: null, text: '' }
    const stand = candidate.releasedAt || null
    if (record?.status === 'nachfolger' && record.successor) {
        return { status: 'nachfolger', stand, text: `Es gibt etwas Neueres: ${record.successor.name}${record.successor.date ? ` (${record.successor.date})` : ''} — kommt erst nach Prüfung in den Katalog.` }
    }
    if (record?.status === 'aktuell') return { status: 'aktuell', stand, text: `Aktuell (geprüft am ${day(record.checkedAt)}).` }
    const age = candidateAgeMonths(candidate, now)
    const old = age !== null && age > MODEL_MAX_AGE_MONTHS
    return { status: 'ungeprueft', stand, text: `Stand ${stand || 'unbekannt'}, noch nicht geprüft${old ? ` — älter als ${MODEL_MAX_AGE_MONTHS} Monate` : ''}.` }
}

function bestFit(fits: FitResult[]): FitResult | null {
    const ranked = [...fits].sort((a, b) => {
        const routeA = a.route === 'katalog-noetig' ? 1 : 0, routeB = b.route === 'katalog-noetig' ? 1 : 0
        return routeA - routeB || b.score - a.score || a.nodeId.localeCompare(b.nodeId)
    })
    return ranked[0] || null
}

function routeNote(fit: FitResult): string {
    if (fit.route === 'host-agent') return 'Ein Knopf: du bekommst eine Karte, erst dein „Ja“ installiert (mit Rückweg).'
    if (fit.route === 'image') return `Auf ${fit.nodeId} nur über ein neues Programm-Abbild (Container), nicht per Knopf.`
    if (fit.route === 'model-volume') return `Auf ${fit.nodeId} nur als Modell im Datenspeicher, nicht per Knopf.`
    return 'Noch nicht per Knopf installierbar (für dieses Programm fehlt ein geprüfter Installationsweg).'
}

function describe(candidate: SoftwareCandidate, input: ToolboxInput, rated: readonly ScoutNode[], now: number): ToolboxEntry {
    const catalog = input.installCatalog || getInstallCatalog()
    const catalogEntry = candidate.catalogId ? findCatalogEntry(candidate.catalogId, catalog) : undefined
    const mine = (input.queue || []).filter(item => candidate.catalogId && item.catalogId === candidate.catalogId)
    const latest = (statuses: Set<string> | ((item: InstallProposal) => boolean)) => [...mine].reverse()
        .find(item => typeof statuses === 'function' ? statuses(item) : statuses.has(item.status))
    const open = latest(OPEN)
    const doneItem = latest(item => item.status === 'done')
    const need = input.demand?.get(candidate.capability)
    const out: ToolboxEntry = {
        id: candidate.id, name: candidate.title, nutzen: candidate.nutzen || NUTZEN_JE_FAEHIGKEIT[candidate.capability], detail: candidate.benefit, faehigkeit: candidate.capability,
        status: 'passt-nicht', statusText: '', knoten: null, empfohlen: false, bedarf: [],
        aktualitaet: freshnessOf(candidate, input.freshness?.[candidate.id], now),
        katalogId: catalogEntry?.id || null, groesseMb: catalogEntry?.sizeMb ?? null, knopf: null, hinweis: '',
        warteschlange: open ? { id: open.id, status: open.status } : null,
    }

    const running = runningOn(candidate, rated, input.scan)
    if (running) return { ...out, status: 'laeuft', statusText: `läuft auf ${running}`, knoten: running, hinweis: 'Ist schon da und in Betrieb.' }

    const viaQueue = doneItem ? doneItem.nodeId : null
    const installed = viaQueue || installedOn(candidate, rated)
    if (installed) {
        const canUndo = doneItem && doneItem.ticketId && doneItem.result?.alreadyInstalled !== true
        return {
            ...out, status: 'installiert', statusText: `installiert auf ${installed}`, knoten: installed,
            knopf: canUndo ? { art: 'entfernen', queueId: doneItem!.id } : null,
            hinweis: canUndo ? 'Entfernen geht über eine Karte; erst dein „Ja“ macht die Installation rückgängig.' : 'Ist schon da.',
        }
    }

    const fits: FitResult[] = []
    const misfits: FitResult[] = []
    let covered: FitResult | null = null
    for (const node of rated) {
        const fit = assessCandidate(candidate, node, { installCatalog: catalog })
        if (fit.status === 'passt') fits.push(fit)
        else if (fit.status === 'vorhanden' && !covered) covered = fit
        else if (fit.status === 'passt-nicht') misfits.push(fit)
    }
    if (covered) {
        const reason = String(covered.reasons[0] || '').replace(/^Fähigkeit schon vorhanden: /, '')
        return { ...out, status: 'abgedeckt', statusText: `nicht nötig: ${reason} (${covered.nodeId})`, knoten: covered.nodeId, hinweis: 'Diese Fähigkeit hat sie schon auf anderem Weg.' }
    }
    const best = bestFit(fits)
    if (!best) {
        const first = misfits[0]
        return { ...out, statusText: first ? `passt nicht: ${first.reasons[0]} (${first.nodeId})` : 'passt nicht: kein bewerteter Rechner', hinweis: 'Passt auf keinen Rechner im Netz.' }
    }
    const hostFit = [...fits].filter(fit => fit.route === 'host-agent').sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))[0]
    const result: ToolboxEntry = {
        ...out, status: 'passt', statusText: `passt auf ${best.nodeId}`, knoten: best.nodeId,
        empfohlen: Boolean(need && need.count > 0), bedarf: need && need.count > 0 ? [...need.evidence] : [],
        hinweis: routeNote(hostFit || best),
    }
    if (open) return { ...result, hinweis: open.status === 'queued' ? 'Ist vorgemerkt und wartet auf deine Freigabe (Karte).' : `Ist vorgemerkt (${open.status}).` }
    if (catalogEntry && hostFit) result.knopf = { art: 'installieren', katalogId: catalogEntry.id, knoten: hostFit.nodeId }
    return result
}

/** The Werkzeugkasten read model (pure; production inputs come from `collectToolbox`). */
export function listToolbox(input: ToolboxInput): Toolbox {
    const now = input.now ?? Date.now()
    const candidates = (input.candidates || getSoftwareCandidates()).entries
    const rated = input.nodes.filter(node => isFresh(node, now))
    const order = new Map(candidates.map((candidate, index) => [candidate.id, index]))
    const gruppen: ToolboxGroup[] = []
    for (const capability of SOFTWARE_CAPABILITIES) {
        const eintraege = candidates.filter(candidate => candidate.capability === capability).map(candidate => describe(candidate, input, rated, now))
        if (!eintraege.length) continue
        eintraege.sort((a, b) => Number(b.empfohlen) - Number(a.empfohlen) || Number(Boolean(b.knopf)) - Number(Boolean(a.knopf)) || order.get(a.id)! - order.get(b.id)!)
        gruppen.push({ faehigkeit: capability, titel: FAEHIGKEIT_TITEL[capability] || CAPABILITY_LABEL[capability], eintraege })
    }
    return {
        generatedAt: new Date(now).toISOString(),
        knoten: input.nodes.map(node => ({ id: node.nodeId, bewertet: isFresh(node, now) })),
        gruppen,
        hinweis: 'Installiert wird nur, was im geprüften Katalog steht — immer erst nach deinem „Ja“ auf der Karte, mit Rückweg.',
    }
}

/** Short answer for Telegram ("was könntest du noch installieren?"). */
export function formatToolboxShort(toolbox: Toolbox, max = 8): string {
    const all = toolbox.gruppen.flatMap(group => group.eintraege)
    const open = all.filter(item => item.status === 'passt')
        .sort((a, b) => Number(b.empfohlen) - Number(a.empfohlen) || Number(Boolean(b.knopf)) - Number(Boolean(a.knopf)))
    const present = all.filter(item => item.status === 'laeuft' || item.status === 'installiert')
    const lines = ['🧰 *Werkzeugkasten* — was mich stärker machen würde:']
    for (const item of open.slice(0, max)) {
        lines.push(`${item.empfohlen ? '⭐' : '➕'} ${item.name}: ${item.nutzen.replace(/\.$/, '')} (${item.statusText}${item.empfohlen ? ', empfohlen, weil gebraucht' : ''}${item.knopf ? '' : ', noch ohne Knopf'})`)
    }
    if (!open.length) lines.push('Gerade nichts Neues, das auf deine Rechner passt.')
    if (present.length) lines.push(`✅ Schon da: ${present.map(item => item.name.replace(/ \(.*\)$/, '')).slice(0, 6).join(', ')}`)
    lines.push('Installieren mit einem Knopf: Desktop-App → Mehr → Werkzeugkasten. Ohne dein „Ja“ auf der Karte passiert nichts.')
    return lines.join('\n')
}

/** Production inputs: same nodes as the Software-Scout, cached freshness only, no search. */
export async function collectToolbox(now = Date.now()): Promise<Toolbox> {
    const { collectScoutNodes } = await import('./software-scout.js')
    const nodes = await collectScoutNodes().catch(() => [] as ScoutNode[])
    let demand: ReadonlyMap<SoftwareCapability, CapabilityDemand> | undefined
    try { demand = await (await import('./software-demand.js')).collectCapabilityDemand(now) } catch { demand = undefined }
    let freshness: Record<string, FreshnessRecord> | undefined
    try { freshness = (await import('./software-freshness.js')).readFreshnessCache() } catch { freshness = undefined }
    let queue: InstallProposal[] | undefined
    try { const { defaultInstallDeps, loadInstallQueue } = await import('./install-queue.js'); queue = loadInstallQueue(defaultInstallDeps()) } catch { queue = undefined }
    // Paket C data if a scan ran; no own scanner here.
    let scan: ToolboxInput['scan'] = null
    try {
        const result = (await import('../mesh/ai-scanner.js')).getLastScanResult()
        if (result) scan = { services: result.services.map(service => ({ name: service.name, provider: service.provider, status: service.status, sourceNode: service.sourceNode, host: service.host })) }
    } catch { scan = null }
    return listToolbox({ nodes, demand, freshness, queue, scan, now })
}
