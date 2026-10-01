/**
 * Eine Abfrage je Modell-Liste (2.82.0 Aufräumen „Inventar“).
 *
 * Beim Start fragten llm-factory, model-resolver, model-discovery und die
 * ProviderRegistry dieselben `/models`-Listen (OpenAI, Anthropic, OpenRouter,
 * Groq, externe Anbieter) jeweils selbst ab. Jetzt geht jede dieser Abfragen
 * hierdurch: gleiche URL + gleiche Zugangsdaten = eine Anfrage, deren Antwort
 * 10 Minuten geteilt wird (Fehler 60 s). Gleichzeitige Aufrufer teilen sich
 * eine laufende Anfrage. Zugangsdaten werden nie gespeichert — der Cache-
 * Schlüssel enthält nur einen Hash der Kopfzeilen.
 */
import { createHash } from 'node:crypto'

export const MODEL_LIST_MAX_AGE_MS = 10 * 60_000
const ERROR_MAX_AGE_MS = 60_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

interface Entry { at: number; ok: boolean; status: number; body?: unknown; error?: string }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Entry>>()
let fetchImpl: typeof fetch = (...args) => fetch(...args)

export interface ModelListResponse { ok: boolean; status: number; cached: boolean; json(): Promise<any> }

/** Only headers that change the answer (auth) are part of the key; Content-Type/Accept are not. */
const keyFor = (url: string, headers: Record<string, string>) => {
    const relevant = Object.entries(headers).filter(([name]) => !['content-type', 'accept', 'user-agent'].includes(name.toLowerCase())).sort()
    return `${url}|${createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16)}`
}

async function load(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Entry> {
    try {
        const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { at: Date.now(), ok: false, status: response.status } }
        const text = await response.text()
        if (text.length > MAX_BODY_BYTES) return { at: Date.now(), ok: false, status: response.status, error: 'Antwort zu groß' }
        return { at: Date.now(), ok: true, status: response.status, body: JSON.parse(text) }
    } catch (error) {
        return { at: Date.now(), ok: false, status: 0, error: String((error as Error)?.message || error).slice(0, 160) }
    }
}

/**
 * Drop-in for `fetch(url, { headers, signal })` at the model-list call sites:
 * returns `ok`/`status`/`json()`, throws on a network error like fetch does.
 */
export async function fetchModelList(url: string, init: { headers?: Record<string, string>; timeoutMs?: number; maxAgeMs?: number } = {}): Promise<ModelListResponse> {
    const headers = init.headers ?? {}
    const key = keyFor(url, headers)
    const maxAge = init.maxAgeMs ?? MODEL_LIST_MAX_AGE_MS
    const cached = cache.get(key)
    let entry: Entry | undefined
    let fromCache = false
    if (cached && Date.now() - cached.at < (cached.ok ? maxAge : Math.min(maxAge, ERROR_MAX_AGE_MS))) { entry = cached; fromCache = true }
    if (!entry) {
        let pending = inflight.get(key)
        if (!pending) {
            pending = load(url, headers, init.timeoutMs ?? 5000).finally(() => inflight.delete(key))
            inflight.set(key, pending)
        } else fromCache = true
        entry = await pending
        cache.set(key, entry)
        while (cache.size > 64) cache.delete(cache.keys().next().value!)
    }
    if (entry.status === 0) throw new Error(entry.error || 'nicht erreichbar')
    const body = entry.body
    return { ok: entry.ok, status: entry.status, cached: fromCache, json: async () => structuredClone(body) }
}

/** Tests only. */
export function resetModelListCache(impl?: typeof fetch): void {
    cache.clear()
    inflight.clear()
    fetchImpl = impl ?? ((...args) => fetch(...args))
}
