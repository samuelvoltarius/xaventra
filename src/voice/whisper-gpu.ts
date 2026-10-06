/**
 * 2.86.1 Ergänzung b: Spracherkennung über einen `whisper-gpu`-Dienst im
 * eigenen Netz (z. B. auf dem Spark).
 *
 *   GET  /health                   → { status: 'ok', model: '…whisper…', device }
 *   POST /v1/audio/transcriptions  OpenAI-kompatibel (multipart: file, model) → { text }
 *
 * Grenze des Dienstes: nur Audio ≤ 30 s. Bei längerem Audio antwortet er mit
 * HTTP 200, text="" und einem error-Feld — das ist hier ein Fehler, nie ein
 * leeres Ergebnis. Längere Sprachnachrichten werden in Stücke ≤ 28 s geteilt
 * (16 kHz mono über den vorhandenen ffmpeg-Wandler); geht das nicht, wird
 * ehrlich abgelehnt statt abgeschnitten. Sprache ist privat: nur ein Dienst im
 * eigenen Netz (eigener Rechner, LAN, Tailnet), nie die Cloud.
 *
 * Eigene, leichte Datei (keine Abhängigkeiten), damit der Scanner sie laden kann.
 */
import type { DiscoveredAIService } from '../mesh/ai-scanner.js'

export const WHISPER_GPU_NAME = 'whisper-gpu'
export const WHISPER_GPU_PORT = 8017
/** Grenze des Dienstes (30 s) mit Sicherheitsabstand. */
export const WHISPER_STUECK_SEK = 28
const SAMPLE_RATE = 16000

export class WhisperZuLangError extends Error {
    constructor(readonly durationSec: number) { super(`Sprachnachricht zu lang (${Math.round(durationSec)} s) und nicht teilbar`) }
}

export function isWhisperGpuHealth(body: string): boolean {
    try {
        const data = JSON.parse(body)
        return Boolean(data && typeof data === 'object' && data.status === 'ok' && typeof data.model === 'string' && /whisper/i.test(data.model))
    } catch { return false }
}

export function whisperGpuModels(body: string): string[] {
    try { const model = JSON.parse(body)?.model; return typeof model === 'string' && model.length <= 120 ? [model] : [] } catch { return [] }
}

/** Eigener Rechner, private Netze (RFC 1918) und das Tailnet (100.64.0.0/10). */
function privateHost(host: string): boolean {
    const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (value === 'localhost' || value === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
    if (!m || [m[1], m[2], m[3], m[4]].some(part => Number(part) > 255)) return false
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
}

const LOOPBACK = ['127.0.0.1', 'localhost', '::1']

/** Bester laufender whisper-gpu-Dienst im eigenen Netz (eigener Rechner zuerst). */
export function findWhisperGpu(services: readonly DiscoveredAIService[], allowHost: (host: string) => boolean = privateHost): DiscoveredAIService | null {
    const usable = services.filter(service => service.name === WHISPER_GPU_NAME && service.status === 'running' && allowHost(service.host)
        // a node that reports „localhost“ means itself — not reachable from here
        && (!LOOPBACK.includes(service.host) || !service.sourceNode || service.sourceNode === 'local'))
    return usable.find(service => LOOPBACK.includes(service.host)) || usable[0] || null
}

export async function discoverWhisperGpu(): Promise<DiscoveredAIService | null> {
    try { return findWhisperGpu((await import('../mesh/ai-scanner.js')).getDiscoveredServices()) } catch { return null }
}

function wav(samples: Int16Array): Buffer {
    const out = Buffer.alloc(44 + samples.length * 2)
    out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVE', 8)
    out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
    out.writeUInt32LE(SAMPLE_RATE, 24); out.writeUInt32LE(SAMPLE_RATE * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
    out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40)
    for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2)
    return out
}

export interface WhisperGpuOptions {
    /** Länge laut Telegram (Sekunden); unbekannt = wird gewandelt und gemessen. */
    durationSec?: number
    fetchImpl?: typeof fetch
    /** Audio → PCM16 mono 16 kHz (ffmpeg); fehlt er, geht nur Audio ≤ 30 s. */
    convert?: (input: Buffer, args: string[]) => Promise<Buffer>
    timeoutMs?: number
    /** Tests: welche Adressen als eigenes Netz gelten. */
    allowHost?: (host: string) => boolean
    signal?: AbortSignal
}

async function postStueck(endpoint: string, audio: Buffer, mime: string, filename: string, opts: WhisperGpuOptions): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename)
    form.append('model', 'whisper-1')
    form.append('language', 'de')
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000)
    const response = await (opts.fetchImpl || fetch)(`${endpoint}/v1/audio/transcriptions`, {
        method: 'POST', body: form, redirect: 'error', signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    } as RequestInit)
    if (!response.ok) throw new Error(`Spracherkennung antwortet mit HTTP ${response.status}`)
    const data = await response.json() as { text?: unknown; error?: unknown }
    const text = String(data?.text ?? '').trim()
    // The service answers 200 with text="" + error (e.g. audio > 30 s): that is a failure.
    if (!text && data?.error) throw new Error(`Spracherkennung: ${String(data.error).slice(0, 160)}`)
    return text
}

/**
 * Sprachnachricht → Text über whisper-gpu. Kurz: ein Aufruf mit der Aufnahme.
 * Lang: in Stücke ≤ 28 s geteilt, Text zusammengesetzt. Nicht teilbar →
 * `WhisperZuLangError` (ehrlich ablehnen, nie stillschweigend abschneiden).
 */
export async function transcribeWithWhisperGpu(endpoint: string, audio: Buffer, mime: string, opts: WhisperGpuOptions = {}): Promise<{ text: string; stuecke: number }> {
    let url: URL
    try { url = new URL(endpoint) } catch { throw new Error('Spracherkennung: ungültige Adresse') }
    if (url.protocol !== 'http:' || !(opts.allowHost || privateHost)(url.hostname)) throw new Error('Spracherkennung muss im eigenen Netz laufen (Sprache geht nie in die Cloud)')
    const origin = url.origin
    const dauer = Number(opts.durationSec)
    if (Number.isFinite(dauer) && dauer > 0 && dauer <= WHISPER_STUECK_SEK) {
        return { text: await postStueck(origin, audio, mime || 'audio/ogg', /ogg|opus/i.test(mime) ? 'sprache.ogg' : 'sprache.wav', opts), stuecke: 1 }
    }
    let pcm: Buffer
    try {
        if (!opts.convert) throw new Error('kein Wandler')
        pcm = await opts.convert(audio, ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'])
    } catch {
        throw new WhisperZuLangError(Number.isFinite(dauer) ? dauer : 0)
    }
    const samples = new Int16Array(Math.floor(pcm.length / 2))
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2)
    const step = WHISPER_STUECK_SEK * SAMPLE_RATE
    const teile: string[] = []
    let stuecke = 0
    for (let start = 0; start < samples.length; start += step) {
        const chunk = samples.subarray(start, Math.min(samples.length, start + step))
        if (chunk.length < SAMPLE_RATE / 4) break // under a quarter second: nothing to hear
        stuecke++
        const text = await postStueck(origin, wav(chunk), 'audio/wav', `sprache-${stuecke}.wav`, opts)
        if (text) teile.push(text)
    }
    return { text: teile.join(' ').replace(/\s{2,}/g, ' ').trim(), stuecke }
}
