/**
 * 2.85 — Aktualität vor dem Vorschlag (Alfred 02.10.: "vor allem ein uralt Modell").
 *
 * Before a MODEL candidate of the release catalog becomes a question, its age is known
 * (`releasedAt` in the catalog) and — when it is older than MODEL_MAX_AGE_MONTHS or the
 * last check is older than FRESHNESS_TTL_MS — a read-only web search over the existing
 * governed search chain (browser_search → brave_search → google_search → web_search via
 * the tool registry and its lifecycle policy) looks for a newer successor.
 *
 * - The query contains only capability, model family and hardware class (never node
 *   names, addresses, sizes of disks, user data).
 * - Results are untrusted: only structured fields are taken — the model NAME from an
 *   Ollama-library or Hugging-Face URL, a YYYY-MM date and parameter sizes — redacted and
 *   clipped. Nothing from a result is ever executed; a successor is never installed: it
 *   becomes a quiet idea and (2.86 Punkt 8) a find for the weekly Katalogpflege task to
 *   Claude (see below) — the release catalog stays the only install path.
 * - Fail closed: no usable search result for an OLD candidate = no card, only a quiet idea
 *   "Aktualität ungeprüft". An empty result list is no proof of "aktuell".
 *
 * The Modell-Scout (src/thinking/model-scout.ts) answers a different question (trending
 * Hugging-Face LLMs that fit vLLM, measured against installed models); it never judges a
 * fixed catalog entry's age, so there is no second implementation of this check.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { SoftwareCandidate, SoftwareCandidateCatalog, SoftwareCapability } from './software-candidates.js'

export const MODEL_MAX_AGE_MONTHS = 9
export const FRESHNESS_TTL_MS = 7 * 24 * 60 * 60_000
/** The existing governed search chain (AGENTS.md "Tool Categories"). */
export const SEARCH_CHAIN = ['browser_search', 'brave_search', 'google_search', 'web_search'] as const

export interface SearchHit { url?: string; title?: string; snippet?: string }
export interface WebSearchPort { search(query: string): Promise<{ tool: string; hits: SearchHit[] }> }

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

export function candidateAgeMonths(candidate: Pick<SoftwareCandidate, 'releasedAt'>, now = Date.now()): number | null {
    const match = /^(20\d\d)-(0[1-9]|1[0-2])$/.exec(String(candidate.releasedAt || ''))
    if (!match) return null
    const date = new Date(now)
    return (date.getUTCFullYear() - Number(match[1])) * 12 + (date.getUTCMonth() + 1 - Number(match[2]))
}

// ---------------------------------------------------------------------------
// Model names: family, version, markers, size (pure, deterministic)
// ---------------------------------------------------------------------------

export interface ModelName { name: string; stem: string; version: number[] | null; markers: string[]; sizesB: number[] }

const SIZE_TOKEN = /^e?(\d+(?:\.\d+)?)b$/

export function parseModelName(raw: string): ModelName | null {
    const lower = String(raw || '').toLowerCase().trim()
    const [name, tag = ''] = lower.split(':')
    if (!/^[a-z][a-z0-9._-]{0,80}$/.test(name)) return null
    const match = /^([a-z]+)[-_]?(\d+(?:\.\d+)*)?(.*)$/.exec(name)
    if (!match) return null
    const stem = match[1]
    let version = match[2] ? match[2].split('.').map(Number) : null
    const tokens = match[3].split(/[^a-z0-9.]+/).filter(Boolean)
    const sizesB: number[] = []
    const markers: string[] = []
    for (const token of [...tokens, ...tag.split(/[^a-z0-9.]+/).filter(Boolean)]) {
        const size = SIZE_TOKEN.exec(token)
        if (size) { sizesB.push(Number(size[1])); continue }
        const v = /^v(\d+(?:\.\d+)*)$/.exec(token)
        if (v) { if (!version) version = v[1].split('.').map(Number); continue }
        if (tokens.includes(token)) markers.push(token)
    }
    return { name, stem, version, markers, sizesB }
}

function compareVersion(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0)
        if (diff) return diff
    }
    return 0
}

const CAPABILITY_TERM: Readonly<Record<SoftwareCapability, string>> = Object.freeze({
    vision: 'vision', embedding: 'embedding', llm: 'llm', stt: 'speech recognition', tts: 'text to speech', browser: 'browser', media: 'media', desktop: 'desktop',
})
const VISION_MARKERS = ['vl', 'vision', 'vlm', 'ocr']

/** Only capability, family and hardware class. */
export function freshnessQuery(candidate: SoftwareCandidate): string {
    const parsed = parseModelName(String(candidate.modelRef || ''))
    const family = parsed?.stem || 'model'
    return `ollama ${CAPABILITY_TERM[candidate.capability]} model ${family} newer than ${parsed?.name || family} ${candidate.gpu === 'nvidia' ? 'gpu' : 'cpu'}`
}

// ---------------------------------------------------------------------------
// Untrusted results → structured hits
// ---------------------------------------------------------------------------

export interface ModelHit { name: string; url: string; date?: string; sizesB: number[] }

const MONTHS: Record<string, number> = {
    january: 1, jan: 1, januar: 1, february: 2, feb: 2, februar: 2, march: 3, mar: 3, märz: 3, maerz: 3, april: 4, apr: 4, may: 5, mai: 5, june: 6, jun: 6, juni: 6,
    july: 7, jul: 7, juli: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12, dezember: 12, dez: 12,
}

function dateFrom(text: string): string | undefined {
    const iso = /\b(20\d\d)-(0[1-9]|1[0-2])(?:-\d\d)?\b/.exec(text)
    if (iso) return `${iso[1]}-${iso[2]}`
    const named = /\b([a-zä]{3,9})\.?\s+(20\d\d)\b/i.exec(text)
    const month = named ? MONTHS[named[1].toLowerCase()] : undefined
    return month ? `${named![2]}-${String(month).padStart(2, '0')}` : undefined
}

function nameFromUrl(raw: string): { name: string; url: string } | null {
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.some(part => part === '..' || part === '.')) return null
    let slug: string | undefined
    if (host === 'ollama.com' && parts[0] === 'library' && parts.length === 2) slug = parts[1]
    else if (host === 'huggingface.co' && parts.length === 2 && !['models', 'datasets', 'spaces', 'docs', 'blog'].includes(parts[0])) slug = parts[1]
    if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?::[A-Za-z0-9._-]{1,40})?$/.test(decodeURIComponent(slug))) return null
    return { name: decodeURIComponent(slug).toLowerCase(), url: `https://${host === 'ollama.com' ? 'ollama.com' : 'huggingface.co'}/${parts.map(part => decodeURIComponent(part)).join('/')}` }
}

export function extractModelHits(hits: readonly SearchHit[]): ModelHit[] {
    const out: ModelHit[] = []
    const seen = new Set<string>()
    for (const raw of hits.slice(0, 20)) {
        if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') continue
        const found = nameFromUrl(raw.url.slice(0, 300))
        if (!found) continue
        const parsed = parseModelName(found.name)
        if (!parsed) continue
        const key = parsed.name
        if (seen.has(key)) continue
        seen.add(key)
        const text = redactSecrets(`${String(raw.title || '').slice(0, 200)} ${String(raw.snippet || '').slice(0, 400)}`)
        const sizes = new Set<number>(parsed.sizesB)
        for (const match of text.toLowerCase().matchAll(/\b(\d+(?:\.\d+)?)\s?b\b/g)) if (Number(match[1]) > 0 && Number(match[1]) < 2000) sizes.add(Number(match[1]))
        const date = dateFrom(text)
        out.push({ name: parsed.name, url: redactSecrets(found.url).slice(0, 200), ...(date ? { date } : {}), sizesB: [...sizes].sort((a, b) => a - b) })
    }
    return out
}

/** A newer model of the same family that fits capability and size class and is not already in the catalog. */
export function findSuccessor(candidate: SoftwareCandidate, hits: readonly ModelHit[], catalog: SoftwareCandidateCatalog): ModelHit | null {
    const own = parseModelName(String(candidate.modelRef || ''))
    if (!own) return null
    const listed = new Set(catalog.entries.map(entry => parseModelName(String(entry.modelRef || ''))?.name).filter(Boolean))
    const ownVersion = own.version || [1]
    const ownSize = own.sizesB[0]
    for (const hit of hits) {
        const other = parseModelName(hit.name)
        if (!other || other.stem !== own.stem || listed.has(other.name) || other.name === own.name || !other.version) continue
        if (compareVersion(other.version, ownVersion) <= 0) continue
        const embeds = other.markers.some(marker => marker.includes('embed'))
        if ((candidate.capability === 'embedding') !== embeds) continue
        if (own.markers.some(marker => VISION_MARKERS.includes(marker)) && !other.markers.some(marker => VISION_MARKERS.includes(marker))) continue
        if (ownSize && hit.sizesB.length && !hit.sizesB.some(size => size <= ownSize * 2)) continue
        if (hit.date && candidate.releasedAt && hit.date <= candidate.releasedAt) continue
        return hit
    }
    return null
}

// ---------------------------------------------------------------------------
// Check with cache (.nova-data/software-scout/aktualitaet.json)
// ---------------------------------------------------------------------------

export type FreshnessStatus = 'aktuell' | 'nachfolger' | 'fehler' | 'ungeprueft'
export interface FreshnessRecord { status: FreshnessStatus; checkedAt: number; query?: string; tool?: string; successor?: { name: string; url: string; date?: string }; reason?: string }
interface CacheFile { version: 1; entries: Record<string, FreshnessRecord> }

const cacheFile = (path?: string) => path || getNovaDataDir('software-scout', 'aktualitaet.json')
function readCache(path?: string): CacheFile {
    try {
        const file = cacheFile(path)
        if (!existsSync(file)) return { version: 1, entries: {} }
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        return raw?.version === 1 && raw.entries && typeof raw.entries === 'object' ? raw : { version: 1, entries: {} }
    } catch { return { version: 1, entries: {} } }
}
function writeCache(cache: CacheFile, path?: string): void {
    try { const file = cacheFile(path); mkdirSync(dirname(file), { recursive: true }); atomicWriteJsonSync(file, cache) } catch { /* next run checks again */ }
}

export interface FreshnessOptions { search?: WebSearchPort | null; cachePath?: string; now?: number; catalog: SoftwareCandidateCatalog }

export async function checkFreshness(candidate: SoftwareCandidate, options: FreshnessOptions): Promise<FreshnessRecord> {
    const now = options.now ?? Date.now()
    const cache = readCache(options.cachePath)
    const cached = cache.entries[candidate.id]
    if (cached && (cached.status === 'aktuell' || cached.status === 'nachfolger') && now - cached.checkedAt < FRESHNESS_TTL_MS) return cached
    if (!options.search) return { status: 'ungeprueft', checkedAt: now, reason: 'keine Websuche angeschlossen' }
    const query = freshnessQuery(candidate)
    let record: FreshnessRecord
    try {
        const result = await options.search.search(query)
        const hits = extractModelHits(Array.isArray(result?.hits) ? result.hits : [])
        const tool = SEARCH_CHAIN.includes(result?.tool as any) ? result.tool : 'websuche'
        if (!hits.length) record = { status: 'fehler', checkedAt: now, query, tool, reason: 'keine verwertbaren Treffer (Ollama/Hugging Face)' }
        else {
            const successor = findSuccessor(candidate, hits, options.catalog)
            record = successor
                ? { status: 'nachfolger', checkedAt: now, query, tool, successor: { name: successor.name, url: successor.url, ...(successor.date ? { date: successor.date } : {}) } }
                : { status: 'aktuell', checkedAt: now, query, tool }
        }
    } catch (error) {
        record = { status: 'fehler', checkedAt: now, query, reason: redactSecrets(String((error as Error)?.message || error)).slice(0, 120) }
    }
    cache.entries[candidate.id] = record
    writeCache(cache, options.cachePath)
    return record
}

export interface FreshnessVerdict { allow: boolean; evidence: string[]; idea?: { title: string; text: string } }

/** Fixed rules: successor → idea; unchecked old candidate → idea; otherwise allowed with evidence. */
export function freshnessVerdict(candidate: SoftwareCandidate, record: FreshnessRecord, now = Date.now()): FreshnessVerdict {
    const age = candidateAgeMonths(candidate, now)
    const stand = candidate.releasedAt ? `Katalogstand ${candidate.releasedAt}` : 'Katalogstand unbekannt'
    if (record.status === 'nachfolger' && record.successor) {
        const { name, url, date } = record.successor
        return {
            allow: false, evidence: [`Quelle: ${url}`, `${candidate.title}: ${stand}`],
            idea: { title: `Neuer Kandidat ${name}${date ? ` (${date})` : ''} statt ${candidate.title} — geht an Claude zur Katalogpflege`,
                text: `Die Websuche (${record.tool || 'Websuche'}) fand einen neueren Nachfolger, der nicht im Katalog steht. ${candidate.title} wird deshalb nicht vorgeschlagen; installiert wird nur, was im Release-Katalog steht. Den Katalogeintrag übernimmt Claude (gesammelter Auftrag, höchstens einer pro Woche).` },
        }
    }
    if (record.status === 'aktuell') return { allow: true, evidence: [`Aktualität geprüft (${record.tool || 'Websuche'}): kein neuerer passender Nachfolger gefunden (${stand})`] }
    const why = record.reason ? ` (${record.reason})` : ''
    if (age !== null && age <= MODEL_MAX_AGE_MONTHS) return { allow: true, evidence: [`Aktualität ungeprüft${why}; ${stand} ist jünger als ${MODEL_MAX_AGE_MONTHS} Monate`] }
    return {
        allow: false, evidence: [`${stand}${age !== null ? ` (${age} Monate alt)` : ''}`],
        idea: { title: `${candidate.title}: Aktualität ungeprüft — nicht vorgeschlagen`,
            text: `Älter als ${MODEL_MAX_AGE_MONTHS} Monate und die Websuche lieferte nichts Verwertbares${why}. Ohne Prüfung schlage ich kein altes Modell vor.` },
    }
}

// ---------------------------------------------------------------------------
// Production port: the existing search chain through the tool registry
// ---------------------------------------------------------------------------

interface RegistryLike { get(name: string): unknown; execute(name: string, params: Record<string, unknown>): Promise<unknown> }

export function createGovernedWebSearch(options: { registry?: RegistryLike } = {}): WebSearchPort {
    return {
        async search(query: string) {
            const registry: RegistryLike = options.registry || (await import('../tools/complete-registry.js')).getToolRegistry()
            for (const tool of SEARCH_CHAIN) {
                if (!registry.get(tool)) continue
                let result: any
                try { result = await registry.execute(tool, { query, count: 8 }) } catch { continue }
                if (!result || typeof result !== 'object' || result.error || result.blocked || !Array.isArray(result.results) || !result.results.length) continue
                const hits = result.results.slice(0, 20).map((item: any) => ({
                    url: typeof item?.url === 'string' ? item.url : typeof item?.link === 'string' ? item.link : undefined,
                    title: typeof item?.title === 'string' ? item.title : undefined,
                    snippet: typeof item?.snippet === 'string' ? item.snippet : typeof item?.description === 'string' ? item.description : typeof item?.text === 'string' ? item.text : undefined,
                }))
                return { tool, hits }
            }
            throw new Error('keine Websuche verfügbar (Suchkette ohne Ergebnis)')
        },
    }
}

// ---------------------------------------------------------------------------
// 2.86 Punkt 8 — Katalogpflege: a model find ends as Claude's task, not the owner's
// ---------------------------------------------------------------------------
//
// Successors found here and the Modell-Scout's finds (Hugging-Face candidates that fit but
// are not installed, measured winners without a vLLM switch target) used to end as an idea
// "Katalogeintrag nötig" / "auf die Zielliste setzen" — work for Alfred. Now they are
// collected (one entry per model, not again for 30 days) and handed over as ONE delegation
// to Claude per week through the existing delegation service (`core/delegation.ts`):
// sources in the cleaned context, `erwartet.art = 'release-tag'` (built-in read-only check:
// the next minor release exists), `aendert: true` → level L2, so the delegation asks with
// its own card as it always does (later a trust ladder like the Doctor handoff).
// Nothing is downloaded, installed or switched here: after the release the candidate is in
// the catalog and need (2.84 E) and freshness decide as before.

export const CATALOG_CARE_INTERVAL_MS = 7 * 24 * 60 * 60_000
/** The same model is not handed over again within this time. */
export const CATALOG_CARE_REPEAT_MS = 30 * 24 * 60 * 60_000
/** A failed hand-over (no URL, card refused) is retried at most once a day. */
export const CATALOG_CARE_RETRY_MS = 24 * 60 * 60_000
const MAX_PENDING = 30
const MAX_PER_TASK = 12

export type CatalogFindingSource = 'software-freshness' | 'modell-scout'
export interface CatalogFinding {
    /** Model name (Ollama library name or Hugging-Face id), lowercase. */
    model: string
    source: CatalogFindingSource
    /** Why it is a candidate, e.g. "Nachfolger von Qwen2.5-VL 3B (Katalogstand 2025-01)". */
    reason: string
    /** Source URL (Ollama library / Hugging Face) — untrusted, name+URL only. */
    url?: string
    capability?: string
    at: number
}
interface CatalogCareFile {
    version: 1
    pending: CatalogFinding[]
    /** model → when and with which delegation it was handed over. */
    sent: Record<string, { at: number; delegationId: string }>
    lastDelegatedAt?: number
    lastDelegationId?: string
    lastAttemptAt?: number
    lastError?: string
}

/** Minimal delegation port (`core/delegation.ts` `delegate`). */
export type CatalogCareDelegate = (request: import('../core/delegation.js').DelegationRequest) => Promise<{ ok: true; record: { id: string } } | { ok: false; reason: string }>

const careFile = (path?: string) => path || getNovaDataDir('software-scout', 'katalogpflege.json')
const MODEL_NAME = /^[a-z0-9][a-z0-9._:/-]{1,120}$/
const cleanText = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function readCatalogCare(options: { path?: string } = {}): CatalogCareFile {
    try {
        const file = careFile(options.path)
        if (!existsSync(file)) return { version: 1, pending: [], sent: {} }
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        if (raw?.version !== 1) return { version: 1, pending: [], sent: {} }
        return {
            version: 1,
            pending: Array.isArray(raw.pending) ? raw.pending.filter((item: any) => item && MODEL_NAME.test(String(item.model)) && Number.isFinite(Number(item.at))) : [],
            sent: raw.sent && typeof raw.sent === 'object' && !Array.isArray(raw.sent) ? raw.sent : {},
            ...(Number.isFinite(raw.lastDelegatedAt) ? { lastDelegatedAt: raw.lastDelegatedAt } : {}),
            ...(typeof raw.lastDelegationId === 'string' ? { lastDelegationId: raw.lastDelegationId } : {}),
            ...(Number.isFinite(raw.lastAttemptAt) ? { lastAttemptAt: raw.lastAttemptAt } : {}),
            ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
        }
    } catch { return { version: 1, pending: [], sent: {} } }
}
function writeCatalogCare(file: CatalogCareFile, path?: string): void {
    try { const target = careFile(path); mkdirSync(dirname(target), { recursive: true }); atomicWriteJsonSync(target, file) } catch { /* next run */ }
}

/** Collect finds (dedupe per model; not again within 30 days after a hand-over). Returns the number added. Never throws. */
export function noteCatalogFindings(findings: readonly CatalogFinding[], options: { path?: string; now?: number } = {}): number {
    try {
        const now = options.now ?? Date.now()
        const file = readCatalogCare(options)
        let added = 0
        for (const raw of findings) {
            const model = String(raw?.model || '').toLowerCase().trim()
            if (!MODEL_NAME.test(model)) continue
            const sent = file.sent[model]
            if (sent && now - Number(sent.at) < CATALOG_CARE_REPEAT_MS) continue
            if (file.pending.some(item => item.model === model)) continue
            const url = typeof raw.url === 'string' && /^https:\/\/(?:ollama\.com|huggingface\.co)\/[A-Za-z0-9._:/-]{1,180}$/.test(raw.url) ? raw.url : undefined
            file.pending.push({
                model, source: raw.source === 'modell-scout' ? 'modell-scout' : 'software-freshness', reason: cleanText(raw.reason, 200),
                ...(url ? { url } : {}), ...(raw.capability ? { capability: cleanText(raw.capability, 20) } : {}), at: Number.isFinite(raw.at) ? raw.at : now,
            })
            added++
        }
        file.pending = file.pending.slice(-MAX_PENDING)
        if (added) writeCatalogCare(file, options.path)
        return added
    } catch { return 0 }
}

/** Where a model stands: handed over (with delegation id) or waiting. */
export function catalogCareStatus(model: string, options: { path?: string } = {}): { delegationId?: string; waiting: boolean } {
    const file = readCatalogCare(options)
    const key = String(model || '').toLowerCase().trim()
    const sent = file.sent[key]
    return sent ? { delegationId: sent.delegationId, waiting: false } : { waiting: file.pending.some(item => item.model === key) }
}

/** Text for an idea: never a config key, only the hand-over or "wartet auf Katalogpflege". */
export function catalogCareNote(model: string, options: { path?: string } = {}): string {
    const status = catalogCareStatus(model, options)
    return status.delegationId ? `an Claude zur Katalogpflege übergeben (${status.delegationId})` : 'wartet auf Katalogpflege (gesammelt, höchstens ein Auftrag pro Woche an Claude)'
}

/** Next minor release tag after `version` (2.84.0 → v2.85.0), or null. */
export function nextMinorTag(version: string): string | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''))
    return match ? `v${match[1]}.${Number(match[2]) + 1}.0` : null
}

async function defaultCatalogDelegate(): Promise<CatalogCareDelegate> {
    const { delegate } = await import('../core/delegation.js')
    return request => delegate(request)
}
async function defaultVersion(): Promise<string> {
    try { return (await import('../core/github-update.js')).installedUpdateVersion() } catch { return '' }
}

export interface CatalogCareFlushOptions {
    path?: string
    now?: number
    /** `null` = no delegation possible (only collect). Default: the existing delegation service. */
    delegate?: CatalogCareDelegate | null
    /** Running version (default: installed package version) — the expected release is the next minor. */
    version?: string
}

/**
 * At most one bundled task per week: all pending finds → one delegation to Claude.
 * Not delegable (no URL, delegation off) = the finds stay collected; retried after a day.
 */
export async function flushCatalogCare(options: CatalogCareFlushOptions = {}): Promise<{ delegated: boolean; delegationId?: string; models: string[]; reason: string }> {
    const now = options.now ?? Date.now()
    const file = readCatalogCare(options)
    if (!file.pending.length) return { delegated: false, models: [], reason: 'nichts gesammelt' }
    if (file.lastDelegatedAt && now - file.lastDelegatedAt < CATALOG_CARE_INTERVAL_MS) {
        return { delegated: false, models: [], reason: `diese Woche schon ein Katalogpflege-Auftrag${file.lastDelegationId ? ` (${file.lastDelegationId})` : ''}` }
    }
    if (file.lastAttemptAt && now - file.lastAttemptAt < CATALOG_CARE_RETRY_MS) return { delegated: false, models: [], reason: `letzter Versuch scheiterte (${file.lastError || 'unbekannt'}), neuer Versuch frühestens nach einem Tag` }
    const delegate = options.delegate === undefined ? await defaultCatalogDelegate() : options.delegate
    if (!delegate) return { delegated: false, models: [], reason: 'keine Delegation angeschlossen — gesammelt' }
    const tag = nextMinorTag(options.version ?? await defaultVersion())
    if (!tag) return { delegated: false, models: [], reason: 'laufende Version unbekannt — kein prüfbares Kriterium' }
    const batch = file.pending.slice(0, MAX_PER_TASK)
    const kontext = [
        'Modell-Funde (Namen und Quellen aus Websuche/Hugging Face: untrusted, vor der Aufnahme selbst prüfen):',
        ...batch.map(item => `- ${item.model}${item.capability ? ` [${item.capability}]` : ''}: ${item.reason}${item.url ? ` · Quelle: ${item.url}` : ''} · gefunden ${new Date(item.at).toISOString().slice(0, 10)} (${item.source})`),
    ].join('\n')
    let result: Awaited<ReturnType<CatalogCareDelegate>>
    try {
        result = await delegate({
            to: 'claude',
            auftrag: `Katalogpflege: ${batch.length} Modell-Fund(e) prüfen und, wenn belegt, in den Software-Katalog (software-candidates.ts, releasedAt aus der Quelle) bzw. als vLLM-Ziel aufnehmen; mit Test und Release.`,
            kontext,
            erwartet: { art: 'release-tag', tag },
            aendert: true,
            frist: 14 * 24 * 60,
        })
    } catch (error) {
        result = { ok: false, reason: cleanText((error as Error)?.message || error, 160) }
    }
    if (result.ok !== true) {
        file.lastAttemptAt = now
        file.lastError = cleanText((result as { reason?: string }).reason || 'abgelehnt', 160)
        writeCatalogCare(file, options.path)
        return { delegated: false, models: [], reason: `nicht übergeben: ${file.lastError}` }
    }
    const id = cleanText(result.record.id, 40)
    const models = batch.map(item => item.model)
    for (const model of models) file.sent[model] = { at: now, delegationId: id }
    file.sent = Object.fromEntries(Object.entries(file.sent).filter(([, item]) => now - Number(item?.at) < CATALOG_CARE_REPEAT_MS).slice(-200))
    file.pending = file.pending.filter(item => !models.includes(item.model))
    file.lastDelegatedAt = now
    file.lastDelegationId = id
    delete file.lastAttemptAt
    delete file.lastError
    writeCatalogCare(file, options.path)
    return { delegated: true, delegationId: id, models, reason: `Katalogpflege-Auftrag ${id} an Claude (${models.length} Modell/e)` }
}
