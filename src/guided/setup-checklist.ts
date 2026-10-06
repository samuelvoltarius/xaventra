/**
 * 2.86 Paket M „Geführt“, Punkt 1 — Einrichtungs-Checkliste „3 von 6 erledigt“.
 *
 * Derived only from real state (nothing is ticked by hand):
 * - „KI-Modell läuft“: a usable local model or a connected cloud model
 *   (Verbindungen → KI-Modelle, Paket C dock).
 * - „Telegram gekoppelt“: a numeric owner id in the Telegram allowlist.
 * - every found device/service with a connect way (Paket A/L view
 *   „Verbindungen → Gefunden“): open until connected; it leaves the list when
 *   the owner declines (device „Nein“ hides it; „Nicht nötig“ here).
 * - connected devices/services stay as ticked items („hakt sich selbst ab“).
 *
 * One button per open item. It never connects by itself: „Verbinden“ opens
 * the EXISTING question (device card in the device message, Paket-A connect
 * card); the owner's Ja on that card decides. When nothing is open, the list
 * is `fertig` and disappears from the app and from the pinned message.
 */
import type { ConnectionsOverview, FoundItem } from '../connections/connections-view.js'
import { loadGuidedState, updateGuidedState, type GuidedOptions } from './guided-store.js'

export type ChecklistAction =
    | { art: 'verbinden'; key: string }
    | { art: 'app'; bereich: 'verbindungen' | 'start' }

export interface ChecklistItem {
    key: string
    titel: string
    erledigt: boolean
    /** One sentence in everyday language: what happens / what to do. */
    satz: string
    /** The one button of an open item. */
    knopf?: { label: string; aktion: ChecklistAction }
}

export interface Checklist {
    erledigt: number
    gesamt: number
    fertig: boolean
    /** „3 von 6 erledigt“ */
    kopf: string
    punkte: ChecklistItem[]
    offen: ChecklistItem[]
}

export interface ChecklistFacts {
    kiBereit: boolean
    telegramGekoppelt: boolean
    /** Found entries that can be connected (device with a connect way or a catalog connector). */
    gefunden: Array<{ key: string; titel: string; verbunden: boolean; weg: 'geraet' | 'katalog'; ref: string }>
    /** Connected services that were not found on the network (e.g. a calendar). */
    verbunden: Array<{ key: string; titel: string }>
    uebersprungen: string[]
}

const AUSGENOMMEN = new Set(['ki-modelle', 'hilfsdienste'])

/** Facts from the „Verbindungen“ overview (pure, testable). */
export function factsFromOverview(view: Pick<ConnectionsOverview, 'gefunden' | 'verbunden'>, input: { telegramGekoppelt: boolean; uebersprungen?: string[] }): ChecklistFacts {
    const kiLokal = view.gefunden.some(item => item.kategorie === 'ki-modelle' && item.verbunden)
    const kiCloud = view.verbunden.some(item => item.status === 'verbunden' && String(item.connectorId || '').startsWith('llm:'))
    const gefunden: ChecklistFacts['gefunden'] = []
    const seen = new Set<string>()
    for (const item of view.gefunden as FoundItem[]) {
        if (AUSGENOMMEN.has(item.kategorie)) continue
        const weg = item.geraet?.verbinden ? 'geraet' as const : item.connectorId ? 'katalog' as const : null
        if (!weg) continue
        const ref = weg === 'geraet' ? String(item.geraet!.id) : String(item.connectorId)
        const key = weg === 'geraet' ? `geraet:${ref}` : `dienst:${ref}`
        if (seen.has(key)) continue
        seen.add(key)
        gefunden.push({ key, titel: String(item.title).slice(0, 60), verbunden: item.verbunden === true, weg, ref })
    }
    const foundConnectors = new Set(gefunden.filter(item => item.weg === 'katalog').map(item => item.ref))
    const verbunden = view.verbunden
        .filter(item => item.status === 'verbunden' && !String(item.connectorId || '').startsWith('llm:') && !foundConnectors.has(String(item.connectorId)))
        .map(item => ({ key: `dienst:${item.connectorId || item.id}`, titel: String(item.title).slice(0, 60) }))
        .filter(item => !seen.has(item.key))
    return { kiBereit: kiLokal || kiCloud, telegramGekoppelt: input.telegramGekoppelt, gefunden, verbunden, uebersprungen: input.uebersprungen || [] }
}

/** The checklist from facts (pure). */
export function buildChecklist(facts: ChecklistFacts): Checklist {
    const skip = new Set(facts.uebersprungen)
    const punkte: ChecklistItem[] = ([
        facts.kiBereit
            ? { key: 'ki', titel: 'KI-Modell läuft', erledigt: true, satz: 'Ich kann denken und antworten.' }
            : { key: 'ki', titel: 'KI-Modell einrichten', erledigt: false, satz: 'Ohne KI-Modell kann ich nicht antworten; in der App geht das mit einem Knopf.', knopf: { label: 'KI einrichten', aktion: { art: 'app', bereich: 'verbindungen' } } },
        facts.telegramGekoppelt
            ? { key: 'telegram', titel: 'Telegram gekoppelt', erledigt: true, satz: 'Du erreichst mich auch unterwegs.' }
            : { key: 'telegram', titel: 'Telegram koppeln', erledigt: false, satz: 'Dann erreichst du mich auch unterwegs; in der App zeige ich dir dafür einen Code zum Scannen.', knopf: { label: 'Koppeln', aktion: { art: 'app', bereich: 'start' } } },
    ] as ChecklistItem[]).filter(item => item.erledigt || !skip.has(item.key))
    for (const item of facts.gefunden) {
        if (item.verbunden) { punkte.push({ key: item.key, titel: item.titel, erledigt: true, satz: `${item.titel} ist verbunden.` }); continue }
        if (skip.has(item.key)) continue
        punkte.push({ key: item.key, titel: `${item.titel} verbinden`, erledigt: false, satz: `Ich habe ${item.titel} gefunden; ein Knopf, dann frage ich dich einmal.`, knopf: { label: 'Verbinden', aktion: { art: 'verbinden', key: item.key } } })
    }
    for (const item of facts.verbunden) punkte.push({ key: item.key, titel: item.titel, erledigt: true, satz: `${item.titel} ist verbunden.` })
    const erledigt = punkte.filter(item => item.erledigt).length
    const offen = punkte.filter(item => !item.erledigt)
    return { erledigt, gesamt: punkte.length, fertig: offen.length === 0, kopf: `${erledigt} von ${punkte.length} erledigt`, punkte, offen }
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

export interface ChecklistDeps extends GuidedOptions {
    overview?: () => Promise<Pick<ConnectionsOverview, 'gefunden' | 'verbunden'>>
    telegramGekoppelt?: () => boolean
    /** Opens the existing device question (default: device-connect `offerDeviceConnection`). */
    offerDevice?: (primaryId: string) => Promise<{ ok: boolean; message: string }>
    /** Opens the existing connect card (default: connect-flow `requestConnect`). */
    requestConnect?: (connectorId: string) => Promise<{ ok: boolean; message: string }>
}

export async function telegramPairedFromConfig(): Promise<boolean> {
    try {
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        const adapter = getTelegramAdapter()
        if (adapter && adapter.getOwnerChatIds().length) return true
    } catch { /* channel not loaded */ }
    try {
        const { readFileSync } = await import('node:fs')
        const { resolveConfigPath } = await import('../config/config-path.js')
        const { getRuntimeRoot } = await import('../core/data-root.js')
        const config = JSON.parse(readFileSync(resolveConfigPath(getRuntimeRoot()), 'utf8'))
        const allow = Array.isArray(config?.channels?.telegram?.allowFrom) ? config.channels.telegram.allowFrom : []
        return allow.some((entry: unknown) => /^\d{1,20}$/.test(String(entry).trim()))
    } catch { return false }
}

export async function collectChecklist(deps: ChecklistDeps = {}): Promise<Checklist> {
    const overview = deps.overview ? await deps.overview() : await (await import('../connections/connections-view.js')).collectConnections({ dataDir: deps.dataDir })
    const paired = deps.telegramGekoppelt ? deps.telegramGekoppelt() : await telegramPairedFromConfig()
    return buildChecklist(factsFromOverview(overview, { telegramGekoppelt: paired, uebersprungen: loadGuidedState(deps).uebersprungen }))
}

/** „Verbinden“ on an open item: opens the existing question — the owner's Ja on it decides. */
export async function startChecklistItem(key: string, deps: ChecklistDeps = {}): Promise<{ ok: boolean; message: string }> {
    const list = await collectChecklist(deps)
    const item = list.offen.find(entry => entry.key === key)
    if (!item || item.knopf?.aktion.art !== 'verbinden') return { ok: false, message: 'Dieser Punkt ist schon erledigt.' }
    const [weg, ...rest] = key.split(':')
    const ref = rest.join(':')
    if (weg === 'geraet') {
        const offer = deps.offerDevice || (async (primaryId: string) => {
            const { offerDeviceConnection, productionDeviceConnectDeps } = await import('../sensing/device-connect.js')
            return offerDeviceConnection(await productionDeviceConnectDeps(), primaryId)
        })
        const result = await offer(ref)
        return { ok: result.ok, message: result.ok ? 'Ich frage dich gleich einmal – ein Ja genügt.' : 'Das geht gerade nicht; ich versuche es später noch einmal.' }
    }
    const request = deps.requestConnect || (async (connectorId: string) => {
        const { requestConnect } = await import('../connections/connect-flow.js')
        return requestConnect({ connectorId, quelle: 'einrichtung' })
    })
    const result = await request(ref)
    return { ok: result.ok, message: result.ok ? 'Ich frage dich gleich einmal – ein Ja genügt.' : 'Das geht gerade nicht; ich versuche es später noch einmal.' }
}

/** „Nicht nötig“: the item leaves the list (kept in guided/state.json). */
export function skipChecklistItem(key: string, opts: GuidedOptions = {}): { ok: boolean; message: string } {
    if (!/^(?:ki|telegram|geraet:[\w:.-]{1,120}|dienst:[\w:.@-]{1,120})$/.test(String(key))) return { ok: false, message: 'Unbekannter Punkt.' }
    updateGuidedState(state => { if (!state.uebersprungen.includes(key)) state.uebersprungen.push(key) }, opts)
    return { ok: true, message: 'Gut, das lasse ich weg.' }
}

