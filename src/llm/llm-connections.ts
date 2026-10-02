/**
 * 2.85 Paket C — KI-Modelle verbinden: automatisch bzw. sehr einfach.
 *
 * One place for the three lists of the "Verbindungen" view (Paket A) and the
 * first start (Paket B), category "KI-Modelle" (plus "Suche" for SearXNG):
 *   - gefunden:  local models/services the KI scanner found on this machine,
 *                the mesh or the own LAN/Tailnet. Datenklasse `lokal` —
 *                usable without a question.
 *   - moeglich:  cloud providers Xaventra can connect to, with the way the
 *                provider OFFICIALLY allows (API key, or account login only
 *                where the provider permits third-party apps).
 *   - verbunden: cloud providers with a verified key, and the official Codex
 *                login (ChatGPT account, owned by the Codex app server).
 *
 * API keys: pasted once (desktop view / API, never a terminal), verified
 * immediately with one read-only model-list call, stored in the existing auth
 * store (`.nova-data/auth.json`, 0600, OAuthManager), never shown again (only
 * the last four characters), errors explained in plain words. Keys only go to
 * their own provider's host.
 *
 * Account login (OAuth) — checked against the providers' official pages on
 * 02.10.2026 (sources in LLM_PROVIDERS):
 *   - OpenRouter: official PKCE flow for third-party apps, no client
 *     registration, localhost callback on any port; result is a user API key.
 *   - OpenAI/ChatGPT: only through the official Codex app server (`/codex
 *     login`), where the user signs in on OpenAI's own page. Xaventra never
 *     runs its own PKCE flow with Codex's client id.
 *   - Anthropic: NO account login (owner rule 30.09.2026; Anthropic does not
 *     permit third-party apps to offer Claude.ai login) — API key only.
 *   - Google Gemini: Gemini-CLI/Code-Assist login in third-party software is
 *     forbidden; own OAuth would need an own registered Google Cloud client
 *     (not created; configurable later) — API key.
 *   - xAI, Mistral, Groq, DeepSeek: no documented third-party login — API key.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'

export type LlmProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'xai' | 'mistral' | 'groq' | 'deepseek'
export type LlmLoginWay = 'openrouter-pkce' | 'codex-app-server'

export interface LlmProviderInfo {
    id: LlmProviderId
    title: string
    /** Where the user creates a key (opened in the browser). */
    keyUrl: string
    /** Read-only check call: lists models or the key's own limits. */
    checkUrl: string
    env: string
    /** Official account login for third-party apps, or why not. */
    konto: { erlaubt: boolean; weg?: LlmLoginWay; hinweis: string; quelle: string; geprueftAm: string }
    wirkung: string
}

const CHECKED = '2026-10-02'

export const LLM_PROVIDERS: readonly LlmProviderInfo[] = Object.freeze([
    {
        id: 'openai', title: 'OpenAI (ChatGPT)', keyUrl: 'https://platform.openai.com/api-keys', checkUrl: 'https://api.openai.com/v1/models', env: 'OPENAI_API_KEY',
        konto: { erlaubt: true, weg: 'codex-app-server', hinweis: 'Anmeldung mit ChatGPT-Konto nur über die offizielle Codex-App (Anmeldeseite von OpenAI); Xaventra sieht kein Passwort und keinen Token.', quelle: 'https://learn.chatgpt.com/docs/auth', geprueftAm: CHECKED },
        wirkung: 'Cloud-Modelle von OpenAI als Rückfall für nicht-private Aufgaben',
    },
    {
        id: 'anthropic', title: 'Anthropic (Claude)', keyUrl: 'https://platform.claude.com/settings/keys', checkUrl: 'https://api.anthropic.com/v1/models', env: 'ANTHROPIC_API_KEY',
        konto: { erlaubt: false, hinweis: 'Anthropic erlaubt Drittanwendungen keine Anmeldung mit Claude-Konto/-Abo — bitte einen API-Key verwenden.', quelle: 'https://code.claude.com/docs/en/legal-and-compliance', geprueftAm: CHECKED },
        wirkung: 'Claude-Modelle über die Anthropic-API (API-Key, Abrechnung nach Nutzung)',
    },
    {
        id: 'gemini', title: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey', checkUrl: 'https://generativelanguage.googleapis.com/v1beta/models', env: 'GEMINI_API_KEY',
        konto: { erlaubt: false, hinweis: 'Google-Konto-Anmeldung über Gemini CLI ist in Drittsoftware untersagt; eigene Anmeldung bräuchte einen eigenen Google-Cloud-OAuth-Client. Bitte API-Key aus AI Studio.', quelle: 'https://ai.google.dev/gemini-api/docs/oauth', geprueftAm: CHECKED },
        wirkung: 'Gemini-Modelle über die Gemini-API',
    },
    {
        id: 'openrouter', title: 'OpenRouter', keyUrl: 'https://openrouter.ai/settings/keys', checkUrl: 'https://openrouter.ai/api/v1/key', env: 'OPENROUTER_API_KEY',
        konto: { erlaubt: true, weg: 'openrouter-pkce', hinweis: 'Offizielle Anmeldung für Drittanwendungen (OAuth PKCE); OpenRouter erzeugt dabei einen Key für Xaventra.', quelle: 'https://openrouter.ai/docs/use-cases/oauth-pkce', geprueftAm: CHECKED },
        wirkung: 'Viele Cloud-Modelle über ein Konto',
    },
    {
        id: 'xai', title: 'xAI (Grok)', keyUrl: 'https://console.x.ai', checkUrl: 'https://api.x.ai/v1/models', env: 'XAI_API_KEY',
        konto: { erlaubt: false, hinweis: 'Keine dokumentierte Konto-Anmeldung für Drittanwendungen — API-Key.', quelle: 'https://docs.x.ai/developers/rest-api-reference', geprueftAm: CHECKED },
        wirkung: 'Grok-Modelle über die xAI-API',
    },
    {
        id: 'mistral', title: 'Mistral', keyUrl: 'https://console.mistral.ai', checkUrl: 'https://api.mistral.ai/v1/models', env: 'MISTRAL_API_KEY',
        konto: { erlaubt: false, hinweis: 'Keine dokumentierte Konto-Anmeldung für Drittanwendungen — API-Key.', quelle: 'https://docs.mistral.ai/api/', geprueftAm: CHECKED },
        wirkung: 'Mistral-Modelle über die Mistral-API',
    },
    {
        id: 'groq', title: 'Groq', keyUrl: 'https://console.groq.com/keys', checkUrl: 'https://api.groq.com/openai/v1/models', env: 'GROQ_API_KEY',
        konto: { erlaubt: false, hinweis: 'Keine dokumentierte Konto-Anmeldung für Drittanwendungen — API-Key.', quelle: 'https://console.groq.com/docs/models', geprueftAm: CHECKED },
        wirkung: 'Schnelle offene Modelle über die Groq-API',
    },
    {
        id: 'deepseek', title: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', checkUrl: 'https://api.deepseek.com/models', env: 'DEEPSEEK_API_KEY',
        konto: { erlaubt: false, hinweis: 'Keine dokumentierte Konto-Anmeldung für Drittanwendungen — API-Key.', quelle: 'https://api-docs.deepseek.com/api/list-models', geprueftAm: CHECKED },
        wirkung: 'DeepSeek-Modelle über die DeepSeek-API',
    },
] satisfies LlmProviderInfo[])

export function findLlmProvider(id: unknown): LlmProviderInfo | undefined {
    return LLM_PROVIDERS.find(provider => provider.id === String(id || '').trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Key check
// ---------------------------------------------------------------------------

export type KeyCheckReason = 'key-ungueltig' | 'kein-guthaben' | 'kein-zugriff' | 'ueberlastet' | 'anbieter-stoerung' | 'netz' | 'format' | 'unbekannt'

export type KeyCheckResult =
    | { ok: true; modelle: number }
    | { ok: false; grund: KeyCheckReason; meldung: string }

const MESSAGES: Record<KeyCheckReason, string> = {
    'key-ungueltig': 'Key ungültig — bitte prüfen, ob er vollständig kopiert wurde oder beim Anbieter widerrufen ist.',
    'kein-guthaben': 'Kein Guthaben — beim Anbieter Guthaben aufladen oder Zahlungsart hinterlegen, dann erneut einfügen.',
    'kein-zugriff': 'Kein Zugriff — der Key darf das nicht (Berechtigung, Region oder Team-Einstellung beim Anbieter).',
    ueberlastet: 'Anbieter gerade überlastet oder Anfragegrenze erreicht — der Key wurde nicht gespeichert, bitte später erneut versuchen.',
    'anbieter-stoerung': 'Störung beim Anbieter — bitte später erneut versuchen.',
    netz: 'Netz — der Anbieter ist nicht erreichbar. Internetverbindung prüfen.',
    format: 'Das sieht nicht wie ein API-Key aus (leer, zu kurz oder mit Leerzeichen).',
    unbekannt: 'Unerwartete Antwort des Anbieters — der Key wurde nicht gespeichert.',
}

const fail = (grund: KeyCheckReason): KeyCheckResult => ({ ok: false, grund, meldung: MESSAGES[grund] })

/** Plain sanity check — no provider prefixes are assumed. */
export function normalizeApiKey(raw: unknown): string | null {
    const key = String(raw ?? '').trim()
    if (key.length < 16 || key.length > 512) return null
    if (!/^[\x21-\x7e]+$/.test(key)) return null
    return key
}

/** Maps the provider's answer to one plain reason (pure, tested). */
export function classifyKeyCheck(status: number, body: string): KeyCheckReason | null {
    const text = String(body || '').slice(0, 4000)
    if (status >= 200 && status < 300) return null
    if (status === 401) return 'key-ungueltig'
    if (status === 400 && /api[_ ]?key[_ ]?(not valid|invalid)|API_KEY_INVALID|invalid api key|incorrect api key/i.test(text)) return 'key-ungueltig'
    if (status === 402) return 'kein-guthaben'
    if (/insufficient_quota|insufficient[_ ]balance|billing|credit balance|prepay|payment required|exceeded your current quota/i.test(text)) return 'kein-guthaben'
    if (status === 403) return /api[_ ]?key|invalid|revoked/i.test(text) && !/region|country|permission/i.test(text) ? 'key-ungueltig' : 'kein-zugriff'
    if (status === 429) return 'ueberlastet'
    if (status >= 500) return 'anbieter-stoerung'
    return 'unbekannt'
}

export function authHeaders(provider: LlmProviderId, key: string): Record<string, string> {
    if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    if (provider === 'gemini') return { 'x-goog-api-key': key }
    return { Authorization: `Bearer ${key}` }
}

type FetchLike = (url: string, init?: any) => Promise<{ status: number; text(): Promise<string> }>

/** One read-only call to the provider's own host. The key goes nowhere else. */
export async function verifyApiKey(provider: LlmProviderId, rawKey: string, deps: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<KeyCheckResult> {
    const info = findLlmProvider(provider)
    if (!info) return fail('unbekannt')
    const key = normalizeApiKey(rawKey)
    if (!key) return fail('format')
    const fetchImpl: FetchLike = deps.fetchImpl || ((url, init) => fetch(url, init) as any)
    let status: number
    let body = ''
    try {
        const response = await fetchImpl(info.checkUrl, {
            method: 'GET', redirect: 'error', headers: { Accept: 'application/json', ...authHeaders(info.id, key) },
            signal: AbortSignal.timeout(Math.max(1000, deps.timeoutMs ?? 10_000)),
        })
        status = response.status
        body = await response.text().catch(() => '')
    } catch {
        return fail('netz')
    }
    const reason = classifyKeyCheck(status, body)
    if (reason) return fail(reason)
    let modelle = 0
    try {
        const data = JSON.parse(body)
        modelle = Array.isArray(data?.data) ? data.data.length : Array.isArray(data?.models) ? data.models.length : 0
    } catch { /* a key endpoint may answer without a list */ }
    return { ok: true, modelle }
}

// ---------------------------------------------------------------------------
// Store (existing auth store, 0600) + non-secret status
// ---------------------------------------------------------------------------

export interface KeyStoreLike {
    setApiKey(profileId: string, provider: string, key: string): void
    getProfile(profileId: string): { type: string; provider?: string; key?: string } | null
    deleteProfile(profileId: string): boolean
}

export const llmKeyProfileId = (provider: LlmProviderId): string => `llm-key:${provider}`

export interface LlmConnectionDeps {
    store?: KeyStoreLike
    fetchImpl?: FetchLike
    env?: NodeJS.ProcessEnv
    statusFile?: string
    now?: () => Date
}

async function defaultStore(): Promise<KeyStoreLike> {
    const { getOAuthManager } = await import('../auth/oauth.js')
    return getOAuthManager() as unknown as KeyStoreLike
}

interface StatusEntry { verbundenAm: string; geprueftAm: string; modelle: number; weg: 'api-key' | 'openrouter-pkce' }
type StatusFile = Record<string, StatusEntry>

const statusPath = (deps: LlmConnectionDeps) => deps.statusFile || getNovaDataDir('llm-connections.json')

function readStatus(deps: LlmConnectionDeps): StatusFile {
    try {
        const file = statusPath(deps)
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) || {} : {}
    } catch { return {} }
}

function writeStatus(deps: LlmConnectionDeps, status: StatusFile): void {
    const file = statusPath(deps)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file, status)
}

/** Only the last four characters, never more. */
export function maskKey(key: string | undefined): string | null {
    const value = String(key || '')
    return value.length >= 16 ? `••••${value.slice(-4)}` : value ? '••••' : null
}

function storedKey(store: KeyStoreLike, provider: LlmProviderId): string | null {
    const profile = store.getProfile(llmKeyProfileId(provider))
    return profile?.type === 'api_key' && typeof profile.key === 'string' && profile.key ? profile.key : null
}

export type ConnectResult =
    | { ok: true; provider: LlmProviderId; maske: string | null; modelle: number }
    | { ok: false; provider: string; grund: KeyCheckReason | 'anbieter-unbekannt'; meldung: string }

/**
 * Paste once → verify → store (0600) → usable. The key is never returned,
 * logged or echoed; only its mask.
 */
export async function connectLlmApiKey(provider: unknown, rawKey: unknown, deps: LlmConnectionDeps = {}, weg: StatusEntry['weg'] = 'api-key'): Promise<ConnectResult> {
    const info = findLlmProvider(provider)
    if (!info) return { ok: false, provider: String(provider || ''), grund: 'anbieter-unbekannt', meldung: 'Diesen Anbieter kenne ich nicht.' }
    const key = normalizeApiKey(rawKey)
    if (!key) return { ok: false, provider: info.id, grund: 'format', meldung: MESSAGES.format }
    const check = await verifyApiKey(info.id, key, { fetchImpl: deps.fetchImpl })
    if (check.ok === false) {
        const failed = check as Extract<KeyCheckResult, { ok: false }>
        return { ok: false, provider: info.id, grund: failed.grund, meldung: failed.meldung }
    }
    const store = deps.store || await defaultStore()
    store.setApiKey(llmKeyProfileId(info.id), info.id, key)
    const now = (deps.now?.() || new Date()).toISOString()
    const status = readStatus(deps)
    status[info.id] = { verbundenAm: status[info.id]?.verbundenAm || now, geprueftAm: now, modelle: check.modelle, weg }
    writeStatus(deps, status)
    applyStoredLlmKeysToEnv({ ...deps, store })
    return { ok: true, provider: info.id, maske: maskKey(key), modelle: check.modelle }
}

export async function disconnectLlmApiKey(provider: unknown, deps: LlmConnectionDeps = {}): Promise<boolean> {
    const info = findLlmProvider(provider)
    if (!info) return false
    const store = deps.store || await defaultStore()
    const env = deps.env || process.env
    const key = storedKey(store, info.id)
    // Only the value this module put there is removed; a key from .env stays.
    if (key && env[info.env] === key) delete env[info.env]
    const removed = store.deleteProfile(llmKeyProfileId(info.id))
    const status = readStatus(deps)
    if (status[info.id]) { delete status[info.id]; writeStatus(deps, status) }
    return removed
}

/**
 * Stored keys behave exactly like keys from `.env`: the provider clients read
 * their environment variable. An existing variable always wins.
 */
export function applyStoredLlmKeysToEnv(deps: { store?: KeyStoreLike; env?: NodeJS.ProcessEnv } = {}): LlmProviderId[] {
    const env = deps.env || process.env
    const store = deps.store
    if (!store) return []
    const applied: LlmProviderId[] = []
    for (const info of LLM_PROVIDERS) {
        if (env[info.env]) continue
        const key = storedKey(store, info.id)
        if (!key) continue
        env[info.env] = key
        applied.push(info.id)
    }
    return applied
}

/** Startup hook (daemon): apply stored keys from the default auth store. */
export async function applyStoredLlmKeysAtStartup(): Promise<LlmProviderId[]> {
    try { return applyStoredLlmKeysToEnv({ store: await defaultStore() }) } catch { return [] }
}

// ---------------------------------------------------------------------------
// OpenRouter account login (official OAuth PKCE for third-party apps)
// ---------------------------------------------------------------------------

const PKCE_TTL_MS = 10 * 60_000
const pending = new Map<string, { verifier: string; createdAt: number }>()

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
export const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'

/** Starts a login; `callbackUrl` is this Xaventra's own callback (or null → code shown on OpenRouter's page). */
export function startOpenRouterLogin(callbackUrl: string | null, now = Date.now()): { url: string; state: string } {
    for (const [state, entry] of pending) if (now - entry.createdAt > PKCE_TTL_MS) pending.delete(state)
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    pending.set(state, { verifier, createdAt: now })
    const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256' })
    if (callbackUrl) {
        const callback = new URL(callbackUrl)
        callback.searchParams.set('state', state)
        params.set('callback_url', callback.toString())
    }
    return { url: `${OPENROUTER_AUTH_URL}?${params.toString()}`, state }
}

/** One-time: the state is consumed whatever happens next. */
export async function completeOpenRouterLogin(state: unknown, code: unknown, deps: LlmConnectionDeps = {}): Promise<ConnectResult> {
    const entry = pending.get(String(state || ''))
    pending.delete(String(state || ''))
    const fetchImpl: FetchLike = deps.fetchImpl || ((url, init) => fetch(url, init) as any)
    if (!entry || Date.now() - entry.createdAt > PKCE_TTL_MS) {
        return { ok: false, provider: 'openrouter', grund: 'unbekannt', meldung: 'Anmeldung abgelaufen oder unbekannt — bitte erneut auf „Mit Konto verbinden“ tippen.' }
    }
    const authCode = String(code || '').trim()
    if (!/^[A-Za-z0-9._~-]{4,512}$/.test(authCode)) return { ok: false, provider: 'openrouter', grund: 'format', meldung: 'Der Anmeldecode fehlt oder ist ungültig.' }
    let key = ''
    try {
        const response = await fetchImpl(OPENROUTER_EXCHANGE_URL, {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ code: authCode, code_verifier: entry.verifier, code_challenge_method: 'S256' }),
            signal: AbortSignal.timeout(10_000),
        })
        const text = await response.text().catch(() => '')
        if (response.status < 200 || response.status >= 300) {
            return { ok: false, provider: 'openrouter', grund: response.status === 403 ? 'key-ungueltig' : 'unbekannt', meldung: response.status === 403 ? 'OpenRouter hat die Anmeldung abgelehnt (Code abgelaufen?) — bitte erneut verbinden.' : MESSAGES.unbekannt }
        }
        key = String(JSON.parse(text)?.key || '')
    } catch {
        return { ok: false, provider: 'openrouter', grund: 'netz', meldung: MESSAGES.netz }
    }
    return connectLlmApiKey('openrouter', key, deps, 'openrouter-pkce')
}

/** Tests only. */
export function resetOpenRouterLogins(): void { pending.clear() }

// ---------------------------------------------------------------------------
// One list: gefunden / möglich / verbunden
// ---------------------------------------------------------------------------

export type LlmConnectionStatus = 'gefunden' | 'moeglich' | 'verbunden'

export interface LlmConnection {
    id: string
    kategorie: 'ki-modelle' | 'suche'
    title: string
    status: LlmConnectionStatus
    datenklasse: 'lokal' | 'cloud'
    /** Local findings are usable without a question; cloud only after connecting. */
    nutzbar: boolean
    wirkung: string
    endpoint?: string
    node?: string
    modelle?: string[]
    /** belegt = proven (probe/ledger/rule, model registry); vermutet = from the model name only. */
    faehigkeiten?: { belegt: string[]; vermutet: string[] }
    anmeldung?: { apiKey: boolean; konto: LlmLoginWay | null; kontoHinweis: string; keyUrl: string; quelle: string; geprueftAm: string }
    /** Only for the owner: last four characters of a stored key. */
    maske?: string | null
    geprueftAm?: string
}

export interface ScanServiceLike { id: string; name: string; type: string; endpoint: string; models: string[]; status: string; sourceNode?: string; host?: string; metadata?: Record<string, unknown> }
export interface RegistryEndpointLike { model: string; baseUrl?: string; capabilities: Array<{ capability: string }> }

export interface ListInputs {
    services?: ScanServiceLike[]
    registry?: { endpoints: RegistryEndpointLike[] } | null
    codex?: { authenticated: boolean; available: boolean } | null
    includeMasks?: boolean
}

const RUNTIME_TITLE: Record<string, string> = {
    vllm: 'vLLM', ollama: 'Ollama', 'lm-studio': 'LM Studio', 'llama-cpp': 'llama.cpp', koboldcpp: 'KoboldCPP', localai: 'LocalAI', tabbyapi: 'TabbyAPI', searxng: 'SearXNG',
}

/** Name hints only — shown as "vermutet", never used as proof. */
export function guessedCapabilities(model: string): string[] {
    const name = model.toLowerCase()
    const out: string[] = []
    if (/embed|nomic|bge|mxbai|e5-|gte-/.test(name)) out.push('embedding')
    else out.push('chat')
    if (/(^|[-_:/.])vl([-_:/.]|$)|vision|llava|pixtral|minicpm-v|gemma-?3|qwen2\.5-?vl|qwen3-?vl/.test(name)) out.push('vision')
    return out
}

const sameHost = (a?: string, b?: string) => {
    try { return Boolean(a && b) && new URL(a!).host === new URL(b!).host } catch { return false }
}

export function buildLlmConnectionList(inputs: ListInputs, store: KeyStoreLike | null, status: StatusFile, env: NodeJS.ProcessEnv): LlmConnection[] {
    const list: LlmConnection[] = []
    const seen = new Set<string>()
    for (const service of inputs.services || []) {
        if (service.status !== 'running') continue
        const search = service.type === 'search'
        if (!search && !['llm', 'vlm', 'embeddings'].includes(service.type)) continue
        if (service.name === 'ollama-embeddings') continue
        const key = `${service.name}@${service.endpoint}`
        if (seen.has(key)) continue
        seen.add(key)
        const belegt = new Set<string>()
        const vermutet = new Set<string>()
        for (const model of service.models || []) {
            for (const ep of inputs.registry?.endpoints || []) {
                if (ep.model === model && sameHost(ep.baseUrl, service.endpoint)) ep.capabilities.forEach(item => belegt.add(item.capability))
            }
            guessedCapabilities(model).forEach(item => vermutet.add(item))
        }
        const label = RUNTIME_TITLE[service.name] || service.name
        const where = service.metadata?.source === 'own-network' ? `im eigenen Netz (${service.host || service.sourceNode})` : service.sourceNode && service.sourceNode !== 'local' ? `auf ${service.sourceNode}` : 'auf diesem Rechner'
        list.push({
            id: `lokal:${key}`, kategorie: search ? 'suche' : 'ki-modelle', title: `${label} ${where}`, status: 'gefunden', datenklasse: 'lokal', nutzbar: true,
            wirkung: search ? 'Private Websuche ohne Key — wird vor Cloud-Suchen genutzt' : `${(service.models || []).length} lokale Modelle — privat, ohne Frage nutzbar`,
            endpoint: service.endpoint, node: service.sourceNode, modelle: [...(service.models || [])],
            ...(search ? {} : { faehigkeiten: { belegt: [...belegt].sort(), vermutet: [...vermutet].filter(item => !belegt.has(item)).sort() } }),
        })
    }
    for (const info of LLM_PROVIDERS) {
        const key = store ? storedKey(store, info.id) : null
        const fromEnv = !key && Boolean(env[info.env])
        const codexConnected = info.id === 'openai' && inputs.codex?.authenticated === true
        const connected = Boolean(key) || fromEnv || codexConnected
        list.push({
            id: `cloud:${info.id}`, kategorie: 'ki-modelle', title: info.title, status: connected ? 'verbunden' : 'moeglich', datenklasse: 'cloud', nutzbar: connected,
            wirkung: `${info.wirkung}${connected ? '' : ' — nur nicht-private Inhalte'}`,
            anmeldung: { apiKey: true, konto: info.konto.erlaubt ? info.konto.weg || null : null, kontoHinweis: info.konto.hinweis, keyUrl: info.keyUrl, quelle: info.konto.quelle, geprueftAm: info.konto.geprueftAm },
            ...(inputs.includeMasks && key ? { maske: maskKey(key) } : {}),
            ...(status[info.id]?.geprueftAm ? { geprueftAm: status[info.id].geprueftAm } : {}),
            ...(codexConnected && !key ? { wirkung: `${info.wirkung} (angemeldet über Codex)` } : {}),
        })
    }
    return list
}

/**
 * Exported for Paket A ("Verbindungen", category KI-Modelle/Suche) and
 * Paket B (first start). Read-only: no scan, no provider call; with a
 * principalId the local Codex app server is asked for its login state.
 */
export async function listLlmConnections(options: { principalId?: string; includeMasks?: boolean } & LlmConnectionDeps & Partial<ListInputs> = {}): Promise<{ gefunden: LlmConnection[]; moeglich: LlmConnection[]; verbunden: LlmConnection[]; alle: LlmConnection[] }> {
    let services = options.services
    if (!services) {
        try { services = (await import('../mesh/ai-scanner.js')).getDiscoveredServices() as unknown as ScanServiceLike[] } catch { services = [] }
    }
    let registry = options.registry
    if (registry === undefined) {
        try { registry = await (await import('../routing/model-registry.js')).collectModelRegistry() } catch { registry = null }
    }
    let codex = options.codex
    if (codex === undefined && options.principalId) {
        try {
            const { readCodexStatus } = await import('../auth/codex-app-server.js')
            const status = await readCodexStatus(options.principalId)
            codex = { authenticated: status.authenticated, available: status.available }
        } catch { codex = null }
    }
    let store: KeyStoreLike | null = options.store || null
    if (!store) { try { store = await defaultStore() } catch { store = null } }
    const alle = buildLlmConnectionList({ services, registry, codex, includeMasks: options.includeMasks }, store, readStatus(options), options.env || process.env)
    return {
        gefunden: alle.filter(item => item.status === 'gefunden'),
        moeglich: alle.filter(item => item.status === 'moeglich'),
        verbunden: alle.filter(item => item.status === 'verbunden'),
        alle,
    }
}
