/**
 * 2.86 Paket O: den Sprachdienst im eigenen Mesh finden und benutzen.
 *
 * Gefunden wird er über den KI-Scanner (Probe `xaventra-voice`, auch über
 * Mesh-Ankündigungen anderer Knoten) — nicht hart verdrahtet. Benutzt wird nur
 * ein Dienst im eigenen Netz (eigener Rechner, LAN, Tailnet): Sprache ist
 * privat und geht nie in die Cloud.
 */
import type { DiscoveredAIService } from '../mesh/ai-scanner.js'
import type { SpokenAudio, VoiceName } from './voice-call.js'
import { isXaventraVoiceHealth, VOICE_SERVICE_NAME, VOICE_SERVICE_PORT } from './voice-contract.js'

export { isXaventraVoiceHealth, VOICE_SERVICE_NAME, VOICE_SERVICE_PORT }

/** Eigener Rechner, private Netze (RFC 1918) und das Tailnet (100.64.0.0/10). Keine Namen: die könnten überall hin zeigen. */
export function isPrivateVoiceHost(host: string): boolean {
    const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (value === 'localhost' || value === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
    if (!m) return false
    const [a, b] = [Number(m[1]), Number(m[2])]
    if ([m[1], m[2], m[3], m[4]].some(part => Number(part) > 255)) return false
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
}

function isLocal(service: DiscoveredAIService): boolean {
    return ['127.0.0.1', 'localhost', '::1'].includes(service.host) || service.sourceNode === 'local'
}

/** Bester laufender Sprachdienst im eigenen Netz, eigener Rechner zuerst. */
export function findVoiceService(services: readonly DiscoveredAIService[]): DiscoveredAIService | null {
    const usable = services.filter(service => service.name === VOICE_SERVICE_NAME && service.status === 'running' && isPrivateVoiceHost(service.host))
    return usable.find(isLocal) || usable[0] || null
}

/** Sucht im letzten Scan-Ergebnis (kein eigener Netzscan; der Scanner läuft ohnehin regelmäßig). */
export async function discoverVoiceService(): Promise<DiscoveredAIService | null> {
    try {
        const scanner = await import('../mesh/ai-scanner.js')
        return findVoiceService(scanner.getDiscoveredServices())
    } catch { return null }
}

export class VoiceServiceClient {
    readonly endpoint: string

    constructor(endpoint: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 60_000) {
        let url: URL
        try { url = new URL(endpoint) } catch { throw new Error('Sprachdienst: ungültige Adresse') }
        if (url.protocol !== 'http:' || !isPrivateVoiceHost(url.hostname)) throw new Error('Sprachdienst muss im eigenen Netz laufen (Sprache geht nie in die Cloud)')
        this.endpoint = url.origin
    }

    private async post(path: string, body: Uint8Array | string, contentType: string, signal?: AbortSignal): Promise<Response> {
        const timeout = AbortSignal.timeout(this.timeoutMs)
        const response = await this.fetchImpl(`${this.endpoint}${path}`, {
            method: 'POST', body, redirect: 'error', headers: { 'Content-Type': contentType },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        } as RequestInit)
        if (!response.ok) throw new Error(`Sprachdienst antwortet mit HTTP ${response.status}`)
        return response
    }

    async transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<{ text: string; durationSec?: number }> {
        const response = await this.post('/v1/transcribe', new Uint8Array(audio), mime || 'application/octet-stream', signal)
        const data = await response.json() as { text?: unknown; durationSec?: unknown }
        return { text: String(data?.text ?? '').trim(), ...(typeof data?.durationSec === 'number' ? { durationSec: data.durationSec } : {}) }
    }

    async speak(text: string, voice: VoiceName = 'female', format: 'wav' | 'ogg' = 'wav', signal?: AbortSignal): Promise<SpokenAudio> {
        const response = await this.post('/v1/speak', JSON.stringify({ text, voice, format }), 'application/json', signal)
        const audio = Buffer.from(await response.arrayBuffer())
        const durationSec = Number(response.headers.get('X-Duration-Sec') || 0)
        return { audio, mime: response.headers.get('Content-Type') || (format === 'ogg' ? 'audio/ogg' : 'audio/wav'), durationSec: Number.isFinite(durationSec) ? durationSec : 0 }
    }

    streamUrl(): string { return `${this.endpoint.replace(/^http:/, 'ws:')}/v1/stream` }
}
