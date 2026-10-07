/**
 * 2.88.2 (live 07.10.2026): "Kannst du dich mit X verbinden?" is first answered from the
 * own connection list. Already connected → say so at once (no model, no URL question).
 * Not connected or unknown → null, the normal path (dienst_finden / dienst_verbinden).
 *
 * 2.89: „Ist X verbunden?“ / „Bist du mit X verbunden?“ is answered from the same truth,
 * yes and no (a plain no only for a known connector or a found device).
 *
 * 2.89: the target is resolved to a catalog connector or a device kind, and the answer
 * comes from the one connection truth (connection-state.ts) — never from a title
 * substring of whatever list happened to be at hand (a „wartet auf Anmeldung“ entry
 * was answered „schon verbunden“). Only helper services without a connector
 * (SearXNG, local models of the registered sources) are still matched by name; their
 * own source says whether they are in use.
 */
import type { Verbindungsstand } from './connection-state.js'
import type { GeraetArt } from '../sensing/device-consolidation.js'

const PATTERNS = [
    /(?:kannst|könntest|koenntest)\s+du\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|meinem|meiner|meinen)?\s*(.+?)\s+(?:verbin\p{L}*|koppeln|anbinden)/iu,
    /^\s*(.+?)\s+(?:kannst|könntest|koenntest)\s+du\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|ihm|ihr)?\s*(?:verbin\p{L}*|koppeln|anbinden)/iu,
    /^\s*verbinde?\s+dich\s+(?:mit|an|zu)\s+(?:dem|der|den|meinem|meiner)?\s*(.+?)\s*[.!?]*\s*$/iu,
]

/** 2.89: "Ist X verbunden?" / "Bist du mit X verbunden?" — a status question, answered yes AND no. */
const STATUS_PATTERNS = [
    /^\s*(?:ist|sind)\s+(?:mein(?:e|en)?\s+|unser(?:e)?\s+|der\s+|die\s+|das\s+)?(.+?)\s+(?:schon\s+|jetzt\s+|noch\s+|eigentlich\s+|wirklich\s+)*(?:verbunden|angebunden|eingerichtet|gekoppelt)\s*[?!.]*\s*$/iu,
    /^\s*bist\s+du\s+(?:schon\s+|jetzt\s+|eigentlich\s+)*(?:mit|an)\s+(?:dem|der|den|meinem|meiner|meinen)?\s*(.+?)\s+(?:verbunden|gekoppelt)\s*[?!.]*\s*$/iu,
]

const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const cleanTarget = (raw: string) => norm(raw).replace(/^(?:dem|der|den)\s+/, '')
const usable = (target: string) => Boolean(target) && target.length <= 60 && !/^(?:dem|der|den|ihm|ihr|es|das|alles)$/.test(target)

/** The question and its target: "verbinden" (can you connect?) or "status" (is it connected?). */
export function parseConnectQuestion(text: string): { target: string; frage: 'verbinden' | 'status' } | null {
    const value = String(text || '').trim()
    if (!value || value.length > 200) return null
    for (const pattern of PATTERNS) {
        const match = pattern.exec(value)
        const target = match ? cleanTarget(match[1]) : ''
        if (usable(target)) return { target, frage: 'verbinden' }
    }
    for (const pattern of STATUS_PATTERNS) {
        const match = pattern.exec(value)
        const target = match ? cleanTarget(match[1]) : ''
        if (usable(target)) return { target, frage: 'status' }
    }
    return null
}

export function connectQuestionTarget(text: string): string | null {
    return parseConnectQuestion(text)?.target ?? null
}

/** Device kinds the owner names in everyday words (the consolidated device art). */
const ART_WORTE: ReadonlyArray<[RegExp, GeraetArt]> = [
    [/^(?:philips\s+)?hue(?:\s+bridge)?$/, 'hue'],
    [/^tuya(?:\s+ger(?:ä|ae)t\w*)?$/, 'tuya'],
    [/^matter(?:\s+ger(?:ä|ae)t\w*)?$/, 'matter'],
    [/^(?:3d\s+)?drucker$/, 'drucker'],
]

export interface ConnectQuestionDeps {
    /** Catalog connectors: id + title (the target is matched against these). */
    connectors: ReadonlyArray<{ name: string; title: string }>
    /** The one connection truth for a connector. */
    connector: (connectorId: string) => Verbindungsstand
    /** The one connection truth for every consolidated device of a kind. */
    geraete: (art: GeraetArt) => Array<{ titel: string; stand: Verbindungsstand }>
    /** Helper services without a connector (registered sources: SearXNG, local models). */
    quellen?: () => ReadonlyArray<{ title: string; verbunden: boolean }>
}

/** What the question is about: a catalog connector, a device kind, or nothing known. */
export function connectQuestionZiel(target: string, connectors: ConnectQuestionDeps['connectors']): { connectorId: string; title: string } | { art: GeraetArt } | null {
    const art = ART_WORTE.find(([muster]) => muster.test(target))?.[1]
    if (art) return { art }
    const hit = connectors.find(entry => norm(entry.title) === target || norm(entry.name) === target)
        || connectors.find(entry => target.length >= 3 && (norm(entry.title).split(' ')[0] === target || norm(entry.title).startsWith(`${target} `)))
    return hit ? { connectorId: hit.name, title: hit.title } : null
}

const weiter = (titel: string, grund: string) => `${titel} ist angefangen, aber noch nicht fertig: ${grund}. Unter „Verbindungen“ geht es mit einem Knopf weiter.`

const nochNicht = (titel: string) => `Nein — ${titel} ist noch nicht verbunden. Wenn du willst, sag einfach „Verbinde dich mit ${titel}“.`

export function answerConnectQuestion(text: string, deps: ConnectQuestionDeps): string | null {
    const parsed = parseConnectQuestion(text)
    if (!parsed) return null
    const { target, frage } = parsed
    const ziel = connectQuestionZiel(target, deps.connectors)
    if (ziel && 'connectorId' in ziel) {
        const stand = deps.connector(ziel.connectorId)
        if (stand.zustand === 'verbunden') return frage === 'status' ? `Ja — ${ziel.title} ist verbunden.` : `Ja — ${ziel.title} ist schon verbunden. Ich nutze es schon.`
        if (stand.zustand === 'wartet') return weiter(ziel.title, stand.grund)
        // "Kannst du dich verbinden?" goes on to the connect tools; "Ist es verbunden?" gets the plain no.
        return frage === 'status' ? nochNicht(ziel.title) : null
    }
    if (ziel && 'art' in ziel) {
        const geraete = deps.geraete(ziel.art)
        const verbunden = geraete.find(item => item.stand.zustand === 'verbunden')
        if (verbunden) return frage === 'status' ? `Ja — ${verbunden.titel} ist verbunden.` : `Ja — ${verbunden.titel} ist schon verbunden.`
        const wartet = geraete.find(item => item.stand.zustand === 'wartet')
        if (wartet) return weiter(wartet.titel, wartet.stand.grund)
        // No device of that kind found: nothing to say from the truth → normal path.
        return frage === 'status' && geraete.length ? nochNicht(geraete[0].titel) : null
    }
    // A helper service without a connector (SearXNG, a local model): its own source decides.
    const hit = (deps.quellen?.() || []).find(entry => entry.verbunden === true && norm(entry.title).split(' ').includes(target.split(' ')[0]) && norm(entry.title).includes(target))
    if (!hit) return null
    const nutzen = /searx|such/i.test(hit.title) ? ' Ich suche schon darüber.' : ' Ich nutze es schon.'
    return `Ja — ${hit.title} ist schon verbunden.${nutzen}`
}

/** Production: the same answer from the real stores (catalog, connections, devices, sources). */
export async function answerConnectQuestionLive(text: string, options: { dataDir?: string } = {}): Promise<string | null> {
    const target = connectQuestionTarget(text)
    if (!target) return null
    const [{ connectionState, standKontext }, { getConnectorCatalog }, { consolidateDevices }, { getNovaDataDir }] = await Promise.all([
        import('./connection-state.js'), import('./connector-catalog.js'), import('../sensing/device-consolidation.js'), import('../core/data-root.js'),
    ])
    const dataDir = options.dataDir || getNovaDataDir()
    const kontext = standKontext(dataDir)
    const connectors = getConnectorCatalog().entries.map(entry => ({ name: entry.name, title: entry.title }))
    let quellen: Array<{ title: string; verbunden: boolean }> = []
    if (!connectQuestionZiel(target, connectors)) {
        // Only helper sources (no connector, no device, no account): SearXNG, local models.
        const { collectConnections } = await import('./connections-view.js')
        const view = await collectConnections({ dataDir })
        quellen = view.gefunden.filter(item => !item.connectorId && !item.geraet && !item.id.startsWith('konto:') && !item.id.startsWith('geraet:'))
            .map(item => ({ title: item.title, verbunden: item.verbunden === true }))
    }
    return answerConnectQuestion(text, {
        connectors,
        connector: connectorId => connectionState(dataDir, { connectorId }, kontext),
        geraete: art => consolidateDevices(kontext.devices, { aliase: kontext.aliase }).geraete
            .filter(g => g.art === art && g.status !== 'abgelehnt' && g.status !== 'aus')
            .map(g => ({ titel: g.titel, stand: connectionState(dataDir, { geraet: g }, kontext) })),
        quellen: () => quellen,
    })
}
