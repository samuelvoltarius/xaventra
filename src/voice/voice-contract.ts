/**
 * 2.86 Paket O: Schnittstelle des lokalen Sprachdienstes (`xaventra-voice`).
 *
 *   GET  /health          → { service: 'xaventra-voice', version: 1, ok, capabilities, voices }
 *   POST /v1/transcribe   Rohdaten (audio/ogg | audio/wav) → { text, durationSec }
 *   POST /v1/speak        { text, voice: 'female'|'male', format: 'wav'|'ogg' } → Audio, Kopf X-Duration-Sec
 *   WS   /v1/stream       PCM16 mono 16 kHz rein → { type: ready|speech_start|partial|final, text? } raus
 *
 * Eigene Datei ohne Abhängigkeiten, damit der Scanner sie laden kann.
 */
export const VOICE_SERVICE_NAME = 'xaventra-voice'
/** 18790 belegt schon Even-G2/Voice-Lab; der Sprachdienst hat einen eigenen Port. */
export const VOICE_SERVICE_PORT = 18795
export const VOICE_SAMPLE_RATE = 16000

export function isXaventraVoiceHealth(body: string): boolean {
    try {
        const data = JSON.parse(body)
        return Boolean(data && typeof data === 'object' && data.service === VOICE_SERVICE_NAME && Array.isArray(data.capabilities))
    } catch { return false }
}
