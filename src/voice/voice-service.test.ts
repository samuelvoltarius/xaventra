import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
    decodeWav, encodeWav, PRE_ROLL_SAMPLES, startVoiceService, VAD_SETTINGS, voicePeerAllowed,
    type VoiceEngine, type VoiceServiceHandle,
} from './voice-service.js'

// Paket O: der Sprachdienst des Knotens, geprüft mit einer Attrappe statt der
// echten Modelle (keine Downloads im Test). Die Audio-Regeln aus dem Voice-Lab
// (15-ms-Rampen, Pre-Roll vor VAD-Start, 16 kHz) sind hier festgehalten.

/** Attrappe: „Sprache“ = Amplitude > 0.1; Erkennung zählt die Samples. */
function fakeEngine(): VoiceEngine & { received: number[] } {
    const received: number[] = []
    return {
        received,
        describe: () => ({ stt: 'Attrappe', voices: { female: 'Ramona', male: 'Thorsten' } }),
        createVad: () => {
            let speech = false
            let silent = 0
            return {
                accept(samples) {
                    const loud = samples.some(v => Math.abs(v) > 0.1)
                    if (loud) { speech = true; silent = 0 } else if (speech && ++silent >= 3) speech = false
                },
                speech: () => speech,
                reset() { speech = false; silent = 0 },
            }
        },
        createStream: () => {
            let count = 0
            return {
                accept(samples) { count += samples.length },
                partial: () => (count > 0 ? `teil ${count}` : ''),
                finish: () => { received.push(count); return `fertig ${count}` },
            }
        },
        synthesize: (_text, _voice) => ({ samples: new Float32Array(2205).fill(0.5), sampleRate: 22050 }),
        transcribe: samples => `datei ${samples.length}`,
    }
}

let handle: VoiceServiceHandle | null = null
afterEach(async () => { await handle?.close(); handle = null })

async function start() {
    const engine = fakeEngine()
    handle = await startVoiceService({ engine, host: '127.0.0.1', port: 0 })
    return { engine, base: `http://127.0.0.1:${handle.port}` }
}

describe('Audio-Regeln aus dem Voice-Lab', () => {
    it('WAV mit 15-ms-Rampen: Anfang und Ende laufen durch Null (kein Knacken)', () => {
        const wav = encodeWav(new Float32Array(1000).fill(0.8), 16000)
        const decoded = decodeWav(wav)
        expect(decoded.sampleRate).toBe(16000)
        expect(Math.abs(decoded.samples[0])).toBeLessThan(0.01)
        expect(Math.abs(decoded.samples[decoded.samples.length - 1])).toBeLessThan(0.01)
        expect(decoded.samples[500]).toBeGreaterThan(0.7)
    })
    it('Pre-Roll 200–300 ms und empfindlicheres VAD', () => {
        expect(PRE_ROLL_SAMPLES / 16000).toBeGreaterThanOrEqual(0.2)
        expect(PRE_ROLL_SAMPLES / 16000).toBeLessThanOrEqual(0.3)
        expect(VAD_SETTINGS.threshold).toBeLessThanOrEqual(0.35)
        expect(VAD_SETTINGS.windowSize).toBe(512) // 32 ms bei 16 kHz
    })
    it('nur eigener Rechner, LAN und Tailnet dürfen zugreifen', () => {
        expect(voicePeerAllowed('127.0.0.1')).toBe(true)
        expect(voicePeerAllowed('::ffff:100.64.0.9')).toBe(true)
        expect(voicePeerAllowed('203.0.113.5')).toBe(false)
        expect(voicePeerAllowed(undefined)).toBe(false)
    })
})

describe('HTTP-Schnittstelle', () => {
    it('/health beschreibt sich so, dass der Scanner ihn findet', async () => {
        const { base } = await start()
        const data = await (await fetch(`${base}/health`)).json()
        expect(data).toMatchObject({ service: 'xaventra-voice', version: 1, ok: true, capabilities: ['stt', 'tts', 'stream'], voices: { female: 'Ramona', male: 'Thorsten' } })
    })
    it('/v1/speak liefert WAV mit Dauer', async () => {
        const { base } = await start()
        const response = await fetch(`${base}/v1/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hallo', voice: 'female', format: 'wav' }) })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/wav')
        expect(Number(response.headers.get('x-duration-sec'))).toBeCloseTo(0.1, 2)
        expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('ascii')).toBe('RIFF')
    })
    it('/v1/speak lehnt leeren oder zu langen Text ab', async () => {
        const { base } = await start()
        const post = (body: unknown) => fetch(`${base}/v1/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        expect((await post({ text: '' })).status).toBe(400)
        expect((await post({ text: 'x'.repeat(2001) })).status).toBe(400)
    })
    it('/v1/transcribe versteht WAV (auf 16 kHz gebracht)', async () => {
        const { base } = await start()
        const wav = encodeWav(new Float32Array(8000).fill(0.2), 8000)
        const response = await fetch(`${base}/v1/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.text).toBe('datei 16000')
        expect(data.durationSec).toBeCloseTo(1, 1)
    })
    it('unbekannte Pfade: 404', async () => {
        const { base } = await start()
        expect((await fetch(`${base}/v1/nix`)).status).toBe(404)
    })
})

describe('/v1/stream (Freisprechen)', () => {
    it('meldet Sprachbeginn, Partials und Endtext — mit Pre-Roll vor dem VAD-Start', async () => {
        const { engine } = await start()
        const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/v1/stream`)
        const events: any[] = []
        const done = new Promise<void>((resolve, reject) => {
            ws.on('message', raw => {
                const event = JSON.parse(String(raw))
                events.push(event)
                if (event.type === 'final') resolve()
            })
            ws.on('error', reject)
        })
        await new Promise(resolve => ws.on('open', resolve))
        const frame = (value: number) => { const pcm = new Int16Array(512).fill(Math.round(value * 32767)); return Buffer.from(pcm.buffer) }
        for (let i = 0; i < 12; i++) ws.send(frame(0.01)) // Raumklang (wird Pre-Roll)
        for (let i = 0; i < 6; i++) ws.send(frame(0.5))   // Sprache
        for (let i = 0; i < 5; i++) ws.send(frame(0))     // Stille → Ende
        await done
        ws.close()
        expect(events[0]).toEqual({ type: 'ready', sampleRate: 16000 })
        const types = events.map(event => event.type)
        expect(types.indexOf('speech_start')).toBeGreaterThan(0)
        expect(types).toContain('partial')
        expect(types[types.length - 1]).toBe('final')
        // Pre-Roll (bis 300 ms = 4800 Samples) wurde vor die erste Sprache gelegt.
        expect(engine.received[0]).toBeGreaterThan(6 * 512 + PRE_ROLL_SAMPLES - 512)
    })
})
