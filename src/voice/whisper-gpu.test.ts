/**
 * 2.86.1 Ergänzung b (Owner 06.10. 22:20): der Spracherkennungsdienst
 * `whisper-gpu` (OpenAI-kompatibel, nimmt nur Audio ≤ 30 s; bei längerem Audio
 * kommt text="" + error statt eines Fehlerstatus) wird erkannt, als
 * Spracherkennung geführt und vom Telegram-Sprachweg benutzt. Kein Netz: alles
 * Attrappen, nur Doku-Adressen.
 */
import { describe, expect, it, vi } from 'vitest'
import { AI_SERVICE_PROBES } from '../mesh/ai-scanner.js'
import { findWhisperGpu, isWhisperGpuHealth, transcribeWithWhisperGpu, WHISPER_GPU_NAME, WHISPER_GPU_PORT, WhisperZuLangError } from './whisper-gpu.js'

const HEALTH = JSON.stringify({ status: 'ok', model: 'openai/whisper-large-v3', device: 'cuda' })

/** Testnetz: die Doku-Adressen 192.0.2.x gelten hier als „eigenes Netz“. */
const heim = (host: string) => host.startsWith('192.0.2.')
/** 16-kHz-Mono-PCM als Rohdaten (so liefert der Wandler). */
const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 16000) * 2)

describe('2.86.1 b: whisper-gpu erkennen', () => {
    it('der KI-Scanner hat eine Probe dafür: Health-JSON mit einem whisper-Modell', () => {
        const probe = AI_SERVICE_PROBES.find(item => item.name === WHISPER_GPU_NAME)!
        expect(probe).toMatchObject({ type: 'stt', defaultPort: 8017, healthEndpoint: '/health' })
        expect(WHISPER_GPU_PORT).toBe(8017)
        expect(probe.detectFn(HEALTH)).toBe(true)
        expect(probe.detectFn(JSON.stringify({ status: 'ok' }))).toBe(false)
        expect(probe.detectFn(JSON.stringify({ status: 'ok', model: 'qwen' }))).toBe(false)
        expect(probe.parseModelsFn!(HEALTH)).toEqual(['openai/whisper-large-v3'])
        expect(isWhisperGpuHealth('kaputt')).toBe(false)
    })

    it('nur ein laufender Dienst im eigenen Netz wird benutzt', () => {
        const base = { id: 'x', name: WHISPER_GPU_NAME, type: 'stt' as const, provider: WHISPER_GPU_NAME, port: 8017, models: [], status: 'running' as const, lastSeen: '' }
        expect(findWhisperGpu([{ ...base, host: '203.0.113.5', endpoint: 'http://203.0.113.5:8017' }])).toBeNull()
        expect(findWhisperGpu([{ ...base, host: '192.0.2.40', endpoint: 'http://192.0.2.40:8017', sourceNode: 'spark' }])).toBeNull()
        expect(findWhisperGpu([{ ...base, host: '192.0.2.40', endpoint: 'http://192.0.2.40:8017', sourceNode: 'spark' }], heim)?.endpoint).toBe('http://192.0.2.40:8017')
    })
})

describe('2.86.1 b: Sprachnachricht über whisper-gpu', () => {
    it('kurze Nachricht: ein Aufruf an /v1/audio/transcriptions', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: ' Mach das Licht aus ' }), { status: 200 }))
        const result = await transcribeWithWhisperGpu('http://192.0.2.40:8017', Buffer.from('OggS'), 'audio/ogg', { durationSec: 4, fetchImpl: fetchImpl as any, allowHost: heim })
        expect(result.text).toBe('Mach das Licht aus')
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        expect(String((fetchImpl.mock.calls[0] as any)[0])).toBe('http://192.0.2.40:8017/v1/audio/transcriptions')
    })

    it('lange Nachricht: in Stücke ≤ 30 s geteilt, Text zusammengesetzt', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'Erster Teil.' })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'Zweiter Teil.' })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'Dritter Teil.' })))
        const convert = vi.fn(async () => pcm(70))
        const result = await transcribeWithWhisperGpu('http://192.0.2.40:8017', Buffer.from('OggS'), 'audio/ogg', { durationSec: 70, fetchImpl: fetchImpl as any, convert, allowHost: heim })
        expect(fetchImpl).toHaveBeenCalledTimes(3)
        expect(result.text).toBe('Erster Teil. Zweiter Teil. Dritter Teil.')
    })

    it('ohne Wandler: lange Nachricht ehrlich ablehnen, nicht abschneiden', async () => {
        const convert = vi.fn(async () => { throw new Error('ffmpeg fehlt') })
        await expect(transcribeWithWhisperGpu('http://192.0.2.40:8017', Buffer.from('OggS'), 'audio/ogg', { durationSec: 45, fetchImpl: vi.fn() as any, convert, allowHost: heim }))
            .rejects.toBeInstanceOf(WhisperZuLangError)
    })

    it('leerer Text + error-Feld ist ein Fehler, kein leeres Ergebnis', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: '', error: 'audio longer than 30 s' }), { status: 200 }))
        await expect(transcribeWithWhisperGpu('http://192.0.2.40:8017', Buffer.from('OggS'), 'audio/ogg', { durationSec: 10, fetchImpl: fetchImpl as any, allowHost: heim }))
            .rejects.toThrow(/Spracherkennung/)
    })

    it('nie außerhalb des eigenen Netzes', async () => {
        await expect(transcribeWithWhisperGpu('http://203.0.113.5:8017', Buffer.from('OggS'), 'audio/ogg', { durationSec: 3, fetchImpl: vi.fn() as any }))
            .rejects.toThrow(/eigenen Netz/)
    })
})
