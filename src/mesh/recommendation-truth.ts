/**
 * 2.89.4: Empfehlungen zu „aktuell / neueste / Stand der Technik / Ende <Jahr>“
 * (Modelle, Software) immer mit Websuche, Datum aus der Systemzeit und Hardware
 * je Knoten (GPU/VRAM vs. CPU-only: kein Großmodell auf purem CPU-Knoten).
 *
 * Ohne verwertbare Suchergebnisse ehrlich „mein Wissen kann veraltet sein“ —
 * ein Katalogstand allein ist kein Beleg für „aktuell“. Kein Install-Angebot
 * ohne passende Hardware.
 */
import type { SearchHit, WebSearchPort } from '../install/software-freshness.js'
import type { HardwareProfile, ModelRecommendation } from './model-recommender.js'

/** The one honest sentence when this run has no usable search evidence. */
export const STALE_NOTE = 'mein Wissen kann veraltet sein'

export interface FreshnessEvidence {
    /** True only when the search chain actually ran in this request. */
    searched: boolean
    tool?: string
    /** System time of the check (ms). */
    checkedAt: number
    hits: number
    /** Short source titles/URLs (already untrusted text, clipped). */
    samples: Array<{ title?: string; url?: string }>
    /** What the reply may claim: search evidence or the honest stale note. */
    note: string
}

/**
 * Owner questions that ask for recommendations about what is current.
 * Inventory („welche Modelle laufen?“) stays out — that is a status question.
 */
export function isFreshnessQuestion(text: unknown): boolean {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!value || value.length > 400) return false
    // An imperative install/bring-up order is not a freshness question.
    if (/^(?:installier|einrichten|einrichte|pull|lade|deploy|kopiere|verbinde)\w*/i.test(value)) return false
    const about = /\b(?:modell\w*|llm|ollama|vllm|software\w*|programm\w*|werkzeug\w*|tools?)\b/i.test(value)
    if (!about) return false
    // Pure inventory is not a freshness question („läuft / installiert / verfügbar“).
    if (/\b(?:läuft|laeuft|laufen|installiert|verfügbar|verfuegbar|online|aktiv|im einsatz)\b/i.test(value)
        && !/\b(?:neueste|stand der technik|state of the art|ende\s+20\d\d|empfehl|empfiehl|vorschlag|wissensstand)\b/i.test(value)) return false
    return /\b(?:neueste[nmrs]?|neuster|neuestes|stand\s+der\s+technik|state\s+of\s+the\s+art|ende\s+20\d\d|ende\s+des\s+jahres|wissensstand)\b/i.test(value)
        || /\b(?:aktuelle[rnms]?|neueste[nmrs]?|beste[rnms]?|modernste[rnms]?)\s+(?:modell\w*|software\w*|llm|programm\w*|werkzeug\w*)/i.test(value)
        || /\b(?:modell\w*|software\w*|llm)\b[\w\s]{0,24}\b(?:ist|sind)\s+(?:aktuell|neueste)/i.test(value)
        || /\b(?:ist|sind)\b[\w\s]{0,32}\b(?:noch\s+)?(?:aktuell|auf\s+dem\s+neuesten\s+stand)\b/i.test(value)
        // „empfehl/empfiehl“ either way round — the about gate already scoped it.
        || /\b(?:empfehl|empfiehl)\w*/i.test(value)
}

/** Search query: capability + class + hardware class only (never node names or sizes). */
export function freshnessQuery(topic: string, hardware?: { hasGpu?: boolean; vramGb?: number }): string {
    const kind = /\b(?:software|programm|werkzeug|tool)\b/i.test(topic) ? 'software' : 'ollama llm model'
    const hw = hardware?.hasGpu
        ? (hardware.vramGb && hardware.vramGb >= 16 ? 'gpu' : 'gpu')
        : 'cpu'
    return `${kind} current ${new Date().getUTCFullYear()} ${hw}`.replace(/\s+/g, ' ').trim()
}

/**
 * One governed web search (SearXNG then the existing search chain).
 * No search, no hits or an error → the honest stale note. Never claims „aktuell“
 * from a catalog date alone.
 */
export async function researchFreshness(topic: string, options: {
    search?: WebSearchPort | null
    now?: number
    hardware?: { hasGpu?: boolean; vramGb?: number }
} = {}): Promise<FreshnessEvidence> {
    const checkedAt = options.now ?? Date.now()
    const query = freshnessQuery(topic, options.hardware)
    let search = options.search
    if (search === undefined) {
        try {
            const { createGovernedWebSearch } = await import('../install/software-freshness.js')
            search = createGovernedWebSearch()
        } catch {
            search = null
        }
    }
    if (!search) {
        return { searched: false, checkedAt, hits: 0, samples: [], note: STALE_NOTE }
    }
    try {
        const result = await search.search(query)
        const hits = (Array.isArray(result?.hits) ? result.hits : [])
            .filter((hit: SearchHit | undefined): hit is SearchHit => Boolean(hit && (hit.url || hit.title || hit.snippet)))
            .slice(0, 5)
        const samples = hits.map((hit: SearchHit) => ({
            ...(hit.title ? { title: String(hit.title).slice(0, 80) } : {}),
            ...(hit.url ? { url: String(hit.url).slice(0, 120) } : {}),
        }))
        if (!hits.length) {
            return { searched: true, ...(result?.tool ? { tool: result.tool } : {}), checkedAt, hits: 0, samples: [], note: STALE_NOTE }
        }
        const tool = result?.tool || 'Websuche'
        return {
            searched: true,
            tool,
            checkedAt,
            hits: hits.length,
            samples,
            note: `geprüft mit ${tool} (${hits.length} Treffer)`,
        }
    } catch {
        return { searched: false, checkedAt, hits: 0, samples: [], note: STALE_NOTE }
    }
}

/** Date stamp from system time — never a guessed year. */
export function freshnessStamp(evidence: Pick<FreshnessEvidence, 'checkedAt' | 'note' | 'samples'>, now = new Date(evidence.checkedAt)): string {
    const date = now.toISOString().slice(0, 10)
    const lines = [`Stand: ${date} (Systemzeit)`, evidence.note]
    for (const sample of evidence.samples.slice(0, 3)) {
        const label = sample.title || sample.url || ''
        if (label) lines.push(`• ${label}`)
    }
    return lines.join('\n')
}

/**
 * Hardware gate: no large model on a pure-CPU node; VRAM and RAM must match.
 * Unknown RAM (0) still allows nano/small/embedding — never a blind large offer.
 */
export function fitsNodeHardware(model: Pick<ModelRecommendation, 'tier' | 'minRamGb' | 'minVramGb' | 'type'>, hw: HardwareProfile): boolean {
    if (!hw?.hasGpu && (model.tier === 'large' || model.tier === 'xlarge')) return false
    if (model.minVramGb && (!hw?.hasGpu || (hw.vramGb ?? 0) < model.minVramGb)) return false
    if (hw?.ramGb > 0 && hw.ramGb < model.minRamGb) return false
    return true
}

/** Install commands only for models that fit this node. */
export function installOffersFor(models: readonly ModelRecommendation[], hw: HardwareProfile): string[] {
    return models
        .filter(model => fitsNodeHardware(model, hw) && model.pullCmd)
        .map(model => model.pullCmd)
}

/**
 * One owner-facing reply for a freshness/recommendation question: system-date
 * stamp, search evidence or the honest stale note, then hardware-capped
 * recommendations. Install lines only when the model fits this node.
 */
export async function formatFreshnessRecommendationReply(options: {
    topic: string
    node?: string
    hardware?: HardwareProfile
    installed?: string[]
    search?: WebSearchPort | null
    now?: number
}): Promise<string> {
    const now = options.now ?? Date.now()
    const evidence = await researchFreshness(options.topic, {
        ...(options.search !== undefined ? { search: options.search } : {}),
        now,
        ...(options.hardware ? { hardware: options.hardware } : {}),
    })
    const { getRecommendations, formatRecommendations } = await import('./model-recommender.js')
    const hw: HardwareProfile = options.hardware || { ramGb: 0, hasGpu: false }
    const recs = getRecommendations(options.node || 'local', hw, options.installed || [])
    recs.freshnessNote = evidence.searched && evidence.hits > 0
        ? evidence.note
        : STALE_NOTE
    const stamp = freshnessStamp(evidence, new Date(now))
    return `${stamp}\n\n${formatRecommendations(recs)}`
}

export default {
    STALE_NOTE,
    isFreshnessQuestion,
    freshnessQuery,
    researchFreshness,
    freshnessStamp,
    fitsNodeHardware,
    installOffersFor,
    formatFreshnessRecommendationReply,
}
