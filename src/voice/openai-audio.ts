/**
 * 2.89.4: OpenAI-kompatible Sprachdienste im eigenen Netz — erkennen, prüfen,
 * benutzen. Statt „Sprachdienst installieren“ anzubieten, wenn einer schon
 * antwortet (z. B. Pocket-TTS, Whisper, LocalAI, Kokoro).
 *
 *   GET  /v1/models                 → { data: [{ id }] }   Erkennung / Live-Sonde
 *   POST /v1/audio/speech           → Audio                TTS (Pocket-TTS & Co.)
 *   POST /v1/audio/transcriptions   → { text }             STT (Whisper & Co.)
 *   WS   /v1/stream                 → optional, falls vorhanden
 *
 * Eigener Knoten zuerst (Env), dann AI-Scan/Mesh. Lokal vor Cloud; Cloud nur
 * als bewusster Fallback. Ohne API-Key auf privaten Adressen — Pocket-TTS und
 * die meisten lokalen Dienste brauchen keinen. Die Stimme des Nutzers geht
 * nie in die Cloud.
 *
 * Eigene, leichte Datei: der Scanner lädt die Detect-Funktionen; kein Import
 * von ai-scanner hier oben (sonst Zirkel) — nur dynamisch in discover*.
 */
import type { DiscoveredAIService } from '../mesh/ai-scanner.js'

export type SpeechKind = 'tts' | 'stt'

export const POCKET_TTS_NAME = 'pocket-tts'
export const OPENAI_AUDIO_STT_NAME = 'openai-audio-stt'
export const POCKET_TTS_PORT = 5002
export const OPENAI_AUDIO_STT_PORT = 8000

const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

/** Eigener Rechner, RFC 1918 und Tailnet (100.64.0.0/10). Keine Klarnamen. */
export function isPrivateSpeechHost(host: string): boolean {
    const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (value === 'localhost' || value === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
    if (!m || [m[1], m[2], m[3], m[4]].some(part => Number(part) > 255)) return false
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
}

function originOf(endpoint: string): string {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Sprachdienst: ungültige Adresse')
    if (!isPrivateSpeechHost(url.hostname)) throw new Error('Sprachdienst muss im eigenen Netz laufen (Sprache geht nie in die Cloud)')
    return url.origin
}

function isLocalService(service: DiscoveredAIService): boolean {
    return LOOPBACK.includes(service.host) && (!service.sourceNode || service.sourceNode === 'local')
}

/** Ein anderer Knoten, der „localhost“ meldet, meint sich selbst — von hier aus nicht erreichbar. */
function reachable(service: DiscoveredAIService): boolean {
    return !LOOPBACK.includes(service.host) || isLocalService(service)
}

function modelIds(body: string): string[] {
    try {
        const data = JSON.parse(body)
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
        return list.map((item: { id?: unknown; name?: unknown }) => String(item?.id ?? item?.name ?? '')).filter(Boolean).slice(0, 24)
    } catch { return [] }
}

/** `/v1/models` mit TTS-Modellen (Pocket-TTS, Kokoro, …) und ohne „nur ASR“. */
export function isPocketTtsHealth(body: string): boolean {
    const ids = modelIds(body)
    if (ids.length) {
        const tts = ids.some(id => /pocket|tts|speech|kokoro|vits|voice|f5/i.test(id))
        const onlyStt = ids.every(id => /whisper|stt|asr|embed/i.test(id))
        return tts && !onlyStt
    }
    return /pocket[-_ ]?tts|kokoro/i.test(body)
}

/** `/v1/models` mit ASR-Modellen (Whisper & Co.). */
export function isOpenAiSttHealth(body: string): boolean {
    const ids = modelIds(body)
    if (ids.length) return ids.some(id => /whisper|stt|asr|moonshine|parakeet/i.test(id))
    return /whisper|openai[-_ ]?audio[-_ ]?stt/i.test(body)
}

export function openAiAudioModels(body: string): string[] {
    return modelIds(body)
}

/** Passt dieser gefundene Dienst als OpenAI-kompatible Sprache? */
export function looksLikeOpenAiAudio(service: DiscoveredAIService, kind: SpeechKind): boolean {
    if (service.status !== 'running') return false
    if (service.type !== (kind === 'tts' ? 'tts' : 'stt')) return false
    const name = service.name.toLowerCase()
    const models = (service.models || []).join(' ').toLowerCase()
    if (kind === 'tts') {
        return /pocket|openai-audio|kokoro|openai-tts|localai/.test(name)
            || (/pocket|tts|speech|kokoro|vits/.test(models) && !/whisper/.test(models))
    }
    return /openai-audio|whisper/.test(name) || /whisper|stt|asr/.test(models)
}

const TTS_ENV = ['XAVENTRA_TTS_BASE_URL', 'POCKET_TTS_URL', 'POCKET_TTS_BASE_URL', 'OPENAI_TTS_BASE_URL', 'KOKORO_BASE_URL']
const STT_ENV = ['XAVENTRA_STT_BASE_URL', 'OPENAI_STT_BASE_URL', 'WHISPER_BASE_URL', 'WHISPER_GPU_URL']

/** Explizit gesetzte Adressen (Env) — eigener Knoten zuerst, in gesetzter Reihenfolge. */
export function envSpeechEndpoints(kind: SpeechKind, env: NodeJS.ProcessEnv = process.env): string[] {
    const keys = kind === 'tts' ? TTS_ENV : STT_ENV
    const out: string[] = []
    for (const key of keys) {
        const value = String(env[key] || '').trim()
        if (!value) continue
        try {
            const origin = originOf(value)
            if (!out.includes(origin)) out.push(origin)
        } catch { /* nur eigene Netze */ }
    }
    return out
}

export interface OpenAiAudioCandidate {
    name: string
    endpoint: string
    kind: SpeechKind
    source: 'env' | 'ai-scan'
    sourceNode?: string
    models?: string[]
}

export function findOpenAiAudio(
    services: readonly DiscoveredAIService[],
    kind: SpeechKind,
    allowHost: (host: string) => boolean = isPrivateSpeechHost,
): DiscoveredAIService | null {
    const usable = services.filter(service => looksLikeOpenAiAudio(service, kind) && allowHost(service.host) && reachable(service))
    return usable.find(isLocalService) || usable[0] || null
}

export interface OpenAiAudioProbe {
    ok: boolean
    models: string[]
    stream?: boolean
    detail?: string
}

export interface OpenAiAudioOptions {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    allowHost?: (host: string) => boolean
    signal?: AbortSignal
    apiKey?: string
    model?: string
    voice?: string
}

/**
 * Lebt der Dienst? GET /v1/models, sonst /health. „Antwortet“ zählt nur mit
 * einem echten HTTP-Erfolg in diesem Lauf — kein Raten aus dem letzten Scan.
 */
export async function probeOpenAiAudio(endpoint: string, kind: SpeechKind, opts: OpenAiAudioOptions = {}): Promise<OpenAiAudioProbe> {
    let origin: string
    try {
        const allow = opts.allowHost || isPrivateSpeechHost
        const url = new URL(endpoint)
        if (!allow(url.hostname)) return { ok: false, models: [], detail: 'nicht im eigenen Netz' }
        origin = url.origin
    } catch { return { ok: false, models: [], detail: 'ungültige Adresse' } }
    const fetchImpl = opts.fetchImpl || fetch
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 4_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    const headers: Record<string, string> = {}
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

    for (const path of ['/v1/models', '/health']) {
        try {
            const response = await fetchImpl(`${origin}${path}`, { method: 'GET', headers, redirect: 'error', signal } as RequestInit)
            if (!response.ok) continue
            const body = await response.text()
            const models = openAiAudioModels(body)
            const looksRight = kind === 'tts'
                ? (isPocketTtsHealth(body) || path === '/health' && /tts|speak|speech|pocket/i.test(body))
                : (isOpenAiSttHealth(body) || path === '/health' && /whisper|stt|transcri|asr/i.test(body))
            if (!looksRight && path === '/v1/models' && models.length === 0) continue
            if (!looksRight && path === '/health') continue
            // /v1/models ohne Sorten-Hinweis: OpenAI-kompatibel reicht für Env-Adressen.
            const ok = looksRight || (path === '/v1/models' && models.length > 0)
            if (!ok) continue
            return {
                ok: true,
                models,
                stream: /"stream"|\/v1\/stream|websocket/i.test(body) || undefined,
                detail: path,
            }
        } catch { /* nächste Sonde */ }
    }
    return { ok: false, models: [], detail: 'antwortet nicht' }
}

/** Optionaler Echtzeit-Stream, falls der Dienst einen anbietet (`/v1/stream`). */
export function openAiAudioStreamUrl(endpoint: string, hasStream?: boolean): string | null {
    if (!hasStream) return null
    try {
        const origin = originOf(endpoint)
        return `${origin.replace(/^http:/, 'ws:')}/v1/stream`
    } catch { return null }
}

/** Env zuerst, dann AI-Scan — erster Kandidat, der live antwortet. */
export async function discoverOpenAiAudio(kind: SpeechKind, opts: OpenAiAudioOptions & {
    services?: readonly DiscoveredAIService[]
    /** Optional credential origin; never carry a key across discovery fallback. */
    apiKeyEndpoint?: string
} = {}): Promise<OpenAiAudioCandidate | null> {
    const candidates: OpenAiAudioCandidate[] = []
    for (const endpoint of envSpeechEndpoints(kind)) {
        candidates.push({ name: kind === 'tts' ? POCKET_TTS_NAME : OPENAI_AUDIO_STT_NAME, endpoint, kind, source: 'env' })
    }
    const services = opts.services ?? await loadDiscoveredServices()
    const found = findOpenAiAudio(services, kind, opts.allowHost || isPrivateSpeechHost)
    if (found && !candidates.some(item => item.endpoint === found.endpoint)) {
        candidates.push({ name: found.name, endpoint: found.endpoint, kind, source: 'ai-scan', sourceNode: found.sourceNode, models: found.models })
    }
    for (const candidate of candidates) {
        let scopedKey: string | undefined
        try {
            if (opts.apiKeyEndpoint && new URL(opts.apiKeyEndpoint).origin === new URL(candidate.endpoint).origin) scopedKey = opts.apiKey
        } catch { /* invalid binding is not credential authority */ }
        const probe = await probeOpenAiAudio(candidate.endpoint, kind, { ...opts, apiKey: scopedKey })
        if (probe.ok) return { ...candidate, models: probe.models.length ? probe.models : candidate.models }
    }
    return null
}

async function loadDiscoveredServices(): Promise<readonly DiscoveredAIService[]> {
    try {
        const scanner = await import('../mesh/ai-scanner.js')
        return scanner.getDiscoveredServices()
    } catch { return [] }
}

export async function discoverOpenAiTts(opts: OpenAiAudioOptions = {}): Promise<OpenAiAudioCandidate | null> {
    return discoverOpenAiAudio('tts', opts)
}

export async function discoverOpenAiStt(opts: OpenAiAudioOptions = {}): Promise<OpenAiAudioCandidate | null> {
    return discoverOpenAiAudio('stt', opts)
}

/**
 * Sprachnachricht → Text über `/v1/audio/transcriptions` (Whisper & Co.).
 * Teilen langer Nachrichten und Privat-Host-Regel wie bei whisper-gpu.
 */
export async function transcribeWithOpenAiStt(
    endpoint: string,
    audio: Buffer,
    mime: string,
    opts: OpenAiAudioOptions & {
        durationSec?: number
        convert?: (input: Buffer, args: string[]) => Promise<Buffer>
    } = {},
): Promise<{ text: string; stuecke: number }> {
    const { transcribeWithWhisperGpu } = await import('./whisper-gpu.js')
    return transcribeWithWhisperGpu(endpoint, audio, mime, {
        durationSec: opts.durationSec,
        fetchImpl: opts.fetchImpl,
        convert: opts.convert,
        timeoutMs: opts.timeoutMs,
        allowHost: opts.allowHost || isPrivateSpeechHost,
        signal: opts.signal,
    })
}

/** Text → Audio über `/v1/audio/speech` (Pocket-TTS & Co.). Privat, Key optional. */
export async function speakWithOpenAiTts(
    endpoint: string,
    text: string,
    opts: OpenAiAudioOptions & { format?: 'opus' | 'ogg' | 'mp3' | 'wav' } = {},
): Promise<{ audio: Buffer; mime: string }> {
    const origin = originOf(endpoint)
    const fetchImpl = opts.fetchImpl || fetch
    const model = opts.model || process.env.OPENAI_TTS_MODEL || process.env.XAVENTRA_TTS_MODEL || 'tts-1'
    const voice = mapVoice(opts.voice)
    const format = opts.format || 'opus'
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = opts.apiKey
    // Discovery is not credential authority. Only an explicit endpoint caller
    // can supply a local-service credential; ambient cloud keys stay local.
    if (key) headers.Authorization = `Bearer ${key}`
    const response = await fetchImpl(`${origin}/v1/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: text, voice, response_format: format }),
        redirect: 'error',
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    } as RequestInit)
    if (!response.ok) {
        throw new Error(`Sprachausgabe antwortet mit HTTP ${response.status}`)
    }
    const audio = Buffer.from(await response.arrayBuffer())
    if (!audio.length) throw new Error('Sprachausgabe: leere Audiodaten')
    const mime = response.headers.get('Content-Type') || (format === 'opus' || format === 'ogg' ? 'audio/ogg' : `audio/${format}`)
    return { audio, mime }
}

function mapVoice(voice?: string): string {
    const value = String(voice || process.env.OPENAI_TTS_VOICE || process.env.XAVENTRA_TTS_VOICE || '').trim()
    if (!value) return 'nova'
    if (value === 'female') return process.env.XAVENTRA_TTS_VOICE_FEMALE || process.env.OPENAI_TTS_VOICE || 'nova'
    if (value === 'male') return process.env.XAVENTRA_TTS_VOICE_MALE || 'onyx'
    return value
}

export interface SpeechServiceProbe {
    anyStt: boolean
    anyTts: boolean
    sttVia?: string
    ttsVia?: string
    sttStream?: boolean
    details: string[]
}

/** Live-Sonde für den eigenen Sprachdienst (`/health` mit seinem Health-JSON). */
async function probeXaventraVoice(endpoint: string, opts: OpenAiAudioOptions): Promise<boolean> {
    try {
        const url = new URL(endpoint)
        if (!(opts.allowHost || isPrivateSpeechHost)(url.hostname)) return false
        const fetchImpl = opts.fetchImpl || fetch
        const timeout = AbortSignal.timeout(opts.timeoutMs ?? 4_000)
        const response = await fetchImpl(`${url.origin}/health`, {
            method: 'GET', redirect: 'error',
            signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        } as RequestInit)
        if (!response.ok) return false
        const { isXaventraVoiceHealth } = await import('./voice-contract.js')
        return isXaventraVoiceHealth(await response.text())
    } catch { return false }
}

/**
 * Welche Sprachdienste antworten gerade? Beleg für Status und dafür, die
 * Install-Karte wegzulassen, wenn schon einer da ist. Nur ein Live-HTTP-Erfolg
 * in diesem Lauf zählt — der letzte Scan allein ist kein „läuft“.
 */
export async function probeSpeechServices(opts: OpenAiAudioOptions = {}): Promise<SpeechServiceProbe> {
    const details: string[] = []
    const out: SpeechServiceProbe = { anyStt: false, anyTts: false, details }

    // 1. eigener Sprachdienst (hört und spricht) — Health live prüfen
    try {
        const { discoverVoiceService } = await import('./voice-mesh.js')
        const service = await discoverVoiceService()
        if (service && await probeXaventraVoice(service.endpoint, opts)) {
            out.anyStt = true
            out.anyTts = true
            out.sttVia = 'sprachdienst'
            out.ttsVia = 'sprachdienst'
            out.sttStream = true
            details.push('sprachdienst')
        }
    } catch { /* optional */ }

    // 2. OpenAI-kompatibel: STT und TTS getrennt (Env + AI-Scan, live geprüft)
    for (const kind of ['stt', 'tts'] as const) {
        try {
            const found = await discoverOpenAiAudio(kind, opts)
            if (!found) continue
            if (kind === 'stt') {
                out.anyStt = true
                out.sttVia = out.sttVia || found.name
                const probe = await probeOpenAiAudio(found.endpoint, 'stt', { ...opts, apiKey: undefined })
                out.sttStream = out.sttStream || probe.stream
            } else {
                out.anyTts = true
                out.ttsVia = out.ttsVia || found.name
            }
            details.push(`${kind}:${found.name}`)
        } catch { /* optional */ }
    }

    // 3. whisper-gpu zählt als STT, wenn seine Health-Antwort noch trägt
    if (!out.anyStt) {
        try {
            const { discoverWhisperGpu, isWhisperGpuHealth } = await import('./whisper-gpu.js')
            const whisper = await discoverWhisperGpu()
            if (whisper) {
                const fetchImpl = opts.fetchImpl || fetch
                const timeout = AbortSignal.timeout(opts.timeoutMs ?? 4_000)
                const response = await fetchImpl(`${new URL(whisper.endpoint).origin}/health`, {
                    method: 'GET', redirect: 'error', signal: timeout,
                } as RequestInit)
                if (response.ok && isWhisperGpuHealth(await response.text())) {
                    out.anyStt = true
                    out.sttVia = 'whisper-gpu'
                    details.push('stt:whisper-gpu')
                }
            }
        } catch { /* optional */ }
    }

    return out
}
