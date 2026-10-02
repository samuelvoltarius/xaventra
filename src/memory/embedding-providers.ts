/**
 * Embedding für das Gedächtnis — nur aus eigenen Quellen (2.84, Punkt 2).
 *
 * Gedächtnis-Einträge (Owner-Aussagen, Korrekturen) sind privat. Sie werden
 * deshalb nur eingebettet von (feste Rangfolge, 2.86 Paket G):
 *   1. `eigen`: das mitgebrachte GGUF-Modell im eigenen Prozess (node-llama-cpp,
 *      local-embedder.ts) — verlässt nicht einmal den Knoten, hängt an keinem
 *      anderen Knoten und keinem Dienst.
 *   2. `lokal`: ein Ollama-Embedding-Modell auf einem eigenen Knoten — aus dem
 *      Modell-Register (Capability-Graph + AIScan-Probes, Privatsphäre `lokal`)
 *      bzw. dem Model-Resolver, nie fest `localhost`. Aufruf über `/api/embed`.
 *   3. `hash`: deterministischer Notbehelf ohne Netz (schlechtere Suche, aber
 *      ehrlich und privat).
 * `openai`/`openrouter` gibt es nur für ausdrücklich nicht-private Texte und
 * nur mit `memory.embedding.allowCloud === true`. Private Texte (Standard)
 * gehen nie an eine Cloud-URL, auch nicht mit gesetztem API-Key.
 *
 * Jeder Vektor trägt seinen Einbetter (`<provider>:<modell>:<dimension>`).
 * Eine LanceDB-Tabelle gehört genau einem Einbetter; mit `only` liefert
 * `embed()` nur diesen oder null — nie still einen anderen Vektorraum.
 */

import type { ModelRegistry } from '../routing/model-registry.js'
import type { InProcessEmbedder } from './local-embedder.js'

// ============================================
// Types
// ============================================

export type EmbeddingProvider = 'eigen' | 'lokal' | 'openai' | 'openrouter' | 'hash'

export interface LocalEmbeddingEndpoint {
    /** Ollama-Basis, z. B. http://<knoten>:11434 */
    baseUrl: string
    model: string
    node?: string
}

export interface EmbeddingResult {
    vector: number[]
    /** `<provider>:<modell>:<dimension>` — ein Vektorraum. */
    embedder: string
    provider: EmbeddingProvider
    model: string
    dimension: number
}

export interface EmbedOptions {
    /** Standard true: Inhalt ist privat und verlässt die eigenen Knoten nie. */
    private?: boolean
    /** Owner-Entscheidung `memory.embedding.allowCloud` (Standard aus); wirkt nur für nicht-private Texte. */
    allowCloud?: boolean
    /** Nur genau diesen Einbetter verwenden (Tabellenbindung); sonst null. */
    only?: string
    /** Dimension des Hash-Notbehelfs. */
    hashDimension?: number
    /** Eigene Einbetter (Tests/Integration). Standard: Register + Resolver. */
    localEndpoints?: () => Promise<LocalEmbeddingEndpoint[]>
    /** Eigener In-Prozess-Einbetter (Tests/Integration). Standard: local-embedder.ts. */
    inProcess?: () => Promise<InProcessEmbedder | null>
    timeoutMs?: number
}

/** Kompatibel zur alten Signatur getEmbedding(text, config). */
export interface EmbeddingConfig extends EmbedOptions {
    dimension: number
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = { dimension: 768 }

const HASH_MODEL = 'v1'
const EMBED_MODEL = /(^|[/:_-])(nomic-embed|mxbai-embed|all-minilm|bge|snowflake-arctic-embed|e5|granite-embedding|paraphrase-multilingual)|embed/i
/**
 * Vorrang unter Ollama-Modellen (geprüft 02.10.2026, ollama.com/search?c=embedding):
 * aktuelle mehrsprachige zuerst — qwen3-embedding (06/2025, 100+ Sprachen),
 * embeddinggemma (09/2025), nomic-embed-text-v2-moe (04/2025),
 * snowflake-arctic-embed2, bge-m3 — dann die alten englischen als Rückfall.
 */
const PREFERRED = ['qwen3-embedding', 'embeddinggemma', 'nomic-embed-text-v2-moe', 'snowflake-arctic-embed2', 'bge-m3', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm']

// ============================================
// Helpers
// ============================================

export function normalizeModelName(model: string): string {
    return String(model || '').trim().replace(/:latest$/i, '')
}

export function embedderId(provider: EmbeddingProvider, model: string, dimension: number): string {
    return `${provider}:${normalizeModelName(model)}:${dimension}`
}

export function parseEmbedderId(id: string | undefined): { provider: string; model: string; dimension: number } | null {
    const match = /^([a-z]+):(.+):(\d+)$/.exec(String(id || ''))
    return match ? { provider: match[1], model: match[2], dimension: Number(match[3]) } : null
}

function ollamaBase(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/api$/i, '')
}

function preferenceRank(model: string): number {
    const name = normalizeModelName(model).toLowerCase()
    const index = PREFERRED.findIndex(pref => name === pref || name.startsWith(`${pref}:`))
    return index >= 0 ? index : PREFERRED.length
}

const provesEmbedding = (ep: ModelRegistry['endpoints'][number]) => ep.capabilities.some(item => item.capability === 'embedding')

/**
 * Eigene Embedding-Endpunkte aus dem Modell-Register: nur Ollama, nur
 * Privatsphäre `lokal`, nicht `down`, und ein Embedding-Modell (Probe-Beleg
 * oder Modellname). Der Aufruf selbst ist der Nutzbarkeits-Beleg.
 */
export function localEmbeddersFromRegistry(registry: Pick<ModelRegistry, 'endpoints'>): LocalEmbeddingEndpoint[] {
    const out: LocalEmbeddingEndpoint[] = []
    const ranked = [...(registry?.endpoints || [])]
        .filter(ep => ep.kind === 'ollama' && ep.privacy === 'lokal' && ep.health !== 'down' && Boolean(ep.baseUrl))
        .filter(ep => provesEmbedding(ep) || EMBED_MODEL.test(ep.model))
        .sort((a, b) => (Number(provesEmbedding(b)) - Number(provesEmbedding(a))) || preferenceRank(a.model) - preferenceRank(b.model))
    for (const ep of ranked) {
        const entry: LocalEmbeddingEndpoint = { baseUrl: ollamaBase(ep.baseUrl!), model: ep.model, ...(ep.node ? { node: ep.node } : {}) }
        if (!out.some(item => item.baseUrl === entry.baseUrl && item.model === entry.model)) out.push(entry)
    }
    return out
}

let discoveryCache: { at: number; endpoints: LocalEmbeddingEndpoint[] } | null = null
const DISCOVERY_TTL_MS = 10 * 60_000

/** Standard-Quelle: Modell-Register, dazu der Resolver-Treffer, wenn er nachweislich lokal ist. */
export async function discoverLocalEmbedders(): Promise<LocalEmbeddingEndpoint[]> {
    if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.endpoints
    const endpoints: LocalEmbeddingEndpoint[] = []
    let knownNodes: string[] = []
    try {
        const { collectModelRegistry } = await import('../routing/model-registry.js')
        const registry = await collectModelRegistry()
        knownNodes = [...new Set(registry.endpoints.map(ep => ep.node).filter((node): node is string => Boolean(node)))]
        endpoints.push(...localEmbeddersFromRegistry(registry))
    } catch { /* Register optional */ }
    try {
        const { resolveModel } = await import('../core/model-resolver.js')
        const { classifyPrivacy } = await import('../routing/model-registry.js')
        const resolved = await resolveModel('embedding')
        if (resolved?.endpoint && resolved.provider === 'ollama' && classifyPrivacy('ollama', resolved.endpoint, resolved.host, knownNodes) === 'lokal') {
            const entry = { baseUrl: ollamaBase(resolved.endpoint), model: resolved.id }
            if (!endpoints.some(item => item.baseUrl === entry.baseUrl && item.model === entry.model)) endpoints.push(entry)
        }
    } catch { /* Resolver optional */ }
    discoveryCache = { at: Date.now(), endpoints }
    return endpoints
}

/** Entdeckung beim nächsten Aufruf neu laufen lassen (Wartungslauf, Tests). */
export function resetEmbeddingDiscovery(): void { discoveryCache = null }

// ============================================
// Provider Implementations
// ============================================

const validVector = (value: unknown): number[] | null =>
    Array.isArray(value) && value.length > 0 && value.every(Number.isFinite) ? value as number[] : null

/**
 * Ollama: aktuelle API `/api/embed` (`input`, Antwort `embeddings[0]`);
 * nur ein alter Server ohne diesen Pfad (404) bekommt `/api/embeddings`.
 */
async function embedWithOllama(text: string, endpoint: LocalEmbeddingEndpoint, timeoutMs: number): Promise<number[] | null> {
    const base = ollamaBase(endpoint.baseUrl)
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    })
    try {
        const response = await post('/api/embed', { model: endpoint.model, input: text.slice(0, 8192), truncate: true })
        if (response.ok) {
            const data = await response.json() as { embeddings?: number[][] }
            return validVector(data.embeddings?.[0])
        }
        if (response.status !== 404) return null
        const legacy = await post('/api/embeddings', { model: endpoint.model, prompt: text.slice(0, 2048) })
        if (!legacy.ok) return null
        const data = await legacy.json() as { embedding?: number[] }
        return validVector(data.embedding)
    } catch { return null }
}

async function defaultInProcess(): Promise<InProcessEmbedder | null> {
    const { getInProcessEmbedder } = await import('./local-embedder.js')
    return getInProcessEmbedder()
}

async function embedWithCloud(provider: 'openai' | 'openrouter', text: string, timeoutMs: number): Promise<{ vector: number[]; model: string } | null> {
    const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY
    if (!apiKey) return null
    const model = provider === 'openai' ? 'text-embedding-3-small' : 'openai/text-embedding-3-small'
    const url = provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : 'https://openrouter.ai/api/v1/embeddings'
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: text.slice(0, 8192) }),
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return null
        const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
        const vector = data.data?.[0]?.embedding
        return Array.isArray(vector) && vector.length > 0 ? { vector, model } : null
    } catch { return null }
}

function embedWithHash(text: string, dimension: number): number[] {
    if (!text || typeof text !== 'string') text = ''
    const embedding = new Array(dimension).fill(0)
    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i)
        const idx = (charCode * (i + 1)) % dimension
        embedding[idx] += Math.sin(charCode + i) * 0.1
    }
    const magnitude = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0))
    return embedding.map((val: number) => val / (magnitude || 1))
}

// ============================================
// Main Function
// ============================================

let lastLogged: string | null = null

/**
 * Einbetten mit dem ersten verfügbaren eigenen Einbetter (bzw. genau `only`).
 * null nur, wenn `only` gesetzt ist und dieser Einbetter gerade nicht antwortet.
 */
export async function embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    const input = typeof text === 'string' ? text : ''
    const isPrivate = options.private !== false
    const timeoutMs = options.timeoutMs ?? 10_000
    const hashDimension = options.hashDimension ?? DEFAULT_EMBEDDING_CONFIG.dimension
    const only = parseEmbedderId(options.only)
    const done = (result: EmbeddingResult): EmbeddingResult => {
        if (lastLogged !== result.embedder) { lastLogged = result.embedder; console.log(`[Embeddings] Einbetter: ${result.embedder}`) }
        return result
    }

    // 1. Eigenes Modell im Prozess.
    if (!only || only.provider === 'eigen') {
        let own: InProcessEmbedder | null = null
        try { own = await (options.inProcess || defaultInProcess)() } catch { own = null }
        const model = own ? normalizeModelName(own.model) : ''
        if (own && (!only || model === only.model)) {
            let vector: number[] | null = null
            try { vector = validVector(await own.embed(input)) } catch { vector = null }
            if (vector && (!only || vector.length === only.dimension)) {
                return done({ vector, embedder: embedderId('eigen', model, vector.length), provider: 'eigen', model, dimension: vector.length })
            }
        }
        if (only) return null
    }

    // 2. Eigenes Mesh-Ollama-Modell.
    if (!only || only.provider === 'lokal') {
        let endpoints: LocalEmbeddingEndpoint[] = []
        try { endpoints = await (options.localEndpoints || discoverLocalEmbedders)() } catch { endpoints = [] }
        for (const endpoint of endpoints) {
            const model = normalizeModelName(endpoint.model)
            if (only && model !== only.model) continue
            const vector = await embedWithOllama(input, endpoint, timeoutMs)
            if (!vector) continue
            if (only && vector.length !== only.dimension) continue
            return done({ vector, embedder: embedderId('lokal', model, vector.length), provider: 'lokal', model, dimension: vector.length })
        }
        if (only) return null
    }

    // Cloud nur für ausdrücklich nicht-private Texte und nur mit Owner-Freigabe.
    if (!isPrivate && options.allowCloud === true) {
        for (const provider of ['openai', 'openrouter'] as const) {
            if (only && only.provider !== provider) continue
            const result = await embedWithCloud(provider, input, timeoutMs)
            if (!result) continue
            const model = normalizeModelName(result.model)
            if (only && (result.vector.length !== only.dimension || model !== only.model)) continue
            return done({ vector: result.vector, embedder: embedderId(provider, model, result.vector.length), provider, model, dimension: result.vector.length })
        }
    }
    if (only && only.provider !== 'hash') return null

    const dimension = only?.dimension || hashDimension
    return done({ vector: embedWithHash(input, dimension), embedder: embedderId('hash', HASH_MODEL, dimension), provider: 'hash', model: HASH_MODEL, dimension })
}

/**
 * Alte Signatur: liefert immer einen Vektor (eigener Einbetter, sonst Hash),
 * in der Hash-Dimension aufgefüllt/gekürzt. Privat, nie Cloud.
 */
export async function getEmbedding(text: string, config: Partial<EmbeddingConfig> = {}): Promise<number[]> {
    const dimension = config.dimension ?? DEFAULT_EMBEDDING_CONFIG.dimension
    const result = await embed(text, { ...config, only: undefined, hashDimension: dimension })
    const vector = result?.vector || embedWithHash(text, dimension)
    if (vector.length === dimension) return vector
    return vector.length > dimension ? vector.slice(0, dimension) : [...vector, ...new Array(dimension - vector.length).fill(0)]
}

export async function batchEmbed(texts: string[], config: Partial<EmbeddingConfig> = {}): Promise<number[][]> {
    return Promise.all(texts.map(text => getEmbedding(text, config)))
}

/** Zuletzt benutzter Einbetter (Anzeige). */
export function getActiveProvider(): string | null {
    return lastLogged
}

export default {
    embed,
    getEmbedding,
    batchEmbed,
    getActiveProvider,
    DEFAULT_EMBEDDING_CONFIG,
}