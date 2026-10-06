/**
 * 2.86 Paket O: der lokale Sprachdienst eines Knotens (`xaventra-voice`).
 *
 * Portiert die Voice-Lab-App von Codex (voice_demo_app.py, ns1, 03.10.2026)
 * nach Node, mit denselben Modellen und Regeln:
 *   - Silero VAD (window 512 = 32 ms bei 16 kHz) mit Pre-Roll vor dem VAD-Start,
 *     damit die erste Silbe nicht abgeschnitten wird;
 *   - Nemotron 3.5 Streaming INT8 (560 ms) mit Partials, Endtext beim VAD-Ende,
 *     kurzer Null-Nachlauf zum Leeren des Transducers;
 *   - Piper/VITS Ramona (Standard) bzw. Thorsten, jede Phrase mit 15-ms-Rampen
 *     an beiden Enden (kein Knacken zwischen Phrasen).
 * Geändert gegenüber dem Lab (offene Live-Probleme laut Alfred):
 *   - Pre-Roll 300 ms (Lab: 800 ms) und Schwelle 0.30 (Lab: 0.35) — „hört mich
 *     die halbe Zeit nicht“; der Browser schickt 16 kHz in 32-ms-Rahmen.
 *   - Kein LLM-Aufruf mehr hier: die Antwort kommt aus der Xaventra-Pipeline
 *     auf dem Main (Gedächtnis, Werkzeuge, Regeln), dieser Dienst hört und spricht nur.
 *
 * Zugriff nur aus dem eigenen Netz (eigener Rechner, LAN, Tailnet).
 */
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import type { VoiceName } from './voice-call.js'
import { VOICE_SAMPLE_RATE, VOICE_SERVICE_NAME, VOICE_SERVICE_PORT } from './voice-contract.js'
import { isPrivateVoiceHost } from './voice-mesh.js'

export interface VoiceVad { accept(samples: Float32Array): void; speech(): boolean; reset(): void }
export interface VoiceAsrStream { accept(samples: Float32Array): void; partial(): string; finish(): string }
export interface VoiceEngine {
    describe(): { stt: string; voices: Record<VoiceName, string> }
    createVad(): VoiceVad
    createStream(): VoiceAsrStream
    synthesize(text: string, voice: VoiceName): { samples: Float32Array; sampleRate: number }
    /** Ganze Aufnahme (16 kHz mono) → Text. */
    transcribe(samples: Float32Array): string
}

/** 300 ms Pre-Roll bei 16 kHz (Messung: 200–300 ms nötig). */
export const PRE_ROLL_SAMPLES = Math.round(0.3 * VOICE_SAMPLE_RATE)
export const VAD_SETTINGS = Object.freeze({ threshold: 0.3, minSilenceDuration: 0.7, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 20 })
const FADE_SEC = 0.015
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 2000

export function voicePeerAllowed(address: string | undefined): boolean {
    const ip = String(address || '').replace(/^::ffff:/, '')
    return Boolean(ip) && isPrivateVoiceHost(ip)
}

// ------------------------------------------------------------------ Audio

export function encodeWav(input: Float32Array, sampleRate: number, fade = true): Buffer {
    const samples = Float32Array.from(input, v => Math.max(-1, Math.min(1, v)))
    if (fade) {
        const n = Math.min(Math.floor(sampleRate * FADE_SEC), Math.floor(samples.length / 2))
        for (let i = 0; i < n; i++) {
            const ramp = i / n
            samples[i] *= ramp
            samples[samples.length - 1 - i] *= ramp
        }
    }
    const data = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(samples[i] * 32767), i * 2)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
}

/** PCM16-WAV (mono oder Mittelwert der Kanäle) → Float32. Wirft bei anderem Format. */
export function decodeWav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('kein WAV')
    let offset = 12
    let channels = 1, sampleRate = 0, bits = 0
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === 'fmt ') {
            if (buffer.readUInt16LE(body) !== 1) throw new Error('WAV: nur PCM')
            channels = buffer.readUInt16LE(body + 2); sampleRate = buffer.readUInt32LE(body + 4); bits = buffer.readUInt16LE(body + 14)
        } else if (id === 'data') {
            if (bits !== 16 || !sampleRate || channels < 1) throw new Error('WAV: nur 16 Bit')
            const end = Math.min(buffer.length, body + size)
            const frames = Math.floor((end - body) / (2 * channels))
            const samples = new Float32Array(frames)
            for (let i = 0; i < frames; i++) {
                let sum = 0
                for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(body + (i * channels + c) * 2)
                samples[i] = sum / channels / 32768
            }
            return { samples, sampleRate }
        }
        offset = body + size + (size % 2)
    }
    throw new Error('WAV: keine Daten')
}

export function resample(samples: Float32Array, from: number, to = VOICE_SAMPLE_RATE): Float32Array {
    if (from === to || samples.length === 0) return samples
    const length = Math.round(samples.length * to / from)
    const out = new Float32Array(length)
    const step = from / to
    for (let i = 0; i < length; i++) {
        const pos = i * step
        const left = Math.floor(pos)
        const right = Math.min(samples.length - 1, left + 1)
        out[i] = samples[left] + (samples[right] - samples[left]) * (pos - left)
    }
    return out
}

export type AudioConverter = (input: Buffer, args: string[]) => Promise<Buffer>

/** ffmpeg ohne Shell, über stdin/stdout. Nur für Ogg/Opus (Telegram); WAV braucht es nicht. */
export const ffmpegConvert: AudioConverter = (input, args) => new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
        if (error) reject(new Error('ffmpeg fehlt oder konnte die Aufnahme nicht lesen'))
        else resolve(Buffer.from(stdout))
    })
    child.stdin?.on('error', () => { /* ffmpeg beendet: Fehler kommt über den Callback */ })
    child.stdin?.end(input)
})

async function toPcm16k(body: Buffer, mime: string, convert: AudioConverter): Promise<Float32Array> {
    if (/wav/i.test(mime) || body.toString('ascii', 0, 4) === 'RIFF') {
        const { samples, sampleRate } = decodeWav(body)
        return resample(samples, sampleRate)
    }
    const raw = await convert(body, ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(VOICE_SAMPLE_RATE), 'pipe:1'])
    const samples = new Float32Array(Math.floor(raw.length / 2))
    for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2) / 32768
    return samples
}

// ------------------------------------------------------------------ Server

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', chunk => {
            size += chunk.length
            if (size > limit) { reject(new Error('zu groß')); req.destroy(); return }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

function json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
}

export interface VoiceServiceOptions {
    engine: VoiceEngine
    host?: string
    port?: number
    convert?: AudioConverter
}

export interface VoiceServiceHandle { port: number; host: string; close(): Promise<void> }

/** Eine Verbindung „Freisprechen“: VAD + Pre-Roll + Partials + Endtext (Voice-Lab call mode). */
function attachStream(ws: WebSocket, engine: VoiceEngine): void {
    const vad = engine.createVad()
    let stream: VoiceAsrStream | null = null
    let speaking = false
    let preRoll = new Float32Array(0)
    let lastPartial = ''
    const send = (event: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)) }
    send({ type: 'ready', sampleRate: VOICE_SAMPLE_RATE })
    ws.on('message', (raw, isBinary) => {
        if (!isBinary) {
            try { if (JSON.parse(String(raw))?.type === 'reset') { vad.reset(); stream = null; speaking = false; preRoll = new Float32Array(0) } } catch { /* ignorieren */ }
            return
        }
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        if (bytes.length < 2 || bytes.length > 64 * 1024) return
        const pcm = new Float32Array(Math.floor(bytes.length / 2))
        for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768
        const wasSpeech = speaking
        if (!wasSpeech) {
            const joined = new Float32Array(preRoll.length + pcm.length)
            joined.set(preRoll); joined.set(pcm, preRoll.length)
            preRoll = joined.slice(Math.max(0, joined.length - PRE_ROLL_SAMPLES))
        }
        vad.accept(pcm)
        speaking = vad.speech()
        if (speaking && !wasSpeech) {
            stream = engine.createStream()
            lastPartial = ''
            send({ type: 'speech_start' })
            stream.accept(preRoll)
            preRoll = new Float32Array(0)
        } else if (speaking && stream) {
            stream.accept(pcm)
        }
        if (speaking && stream) {
            const partial = stream.partial().trim()
            if (partial && partial !== lastPartial) { lastPartial = partial; send({ type: 'partial', text: partial }) }
        }
        if (wasSpeech && !speaking && stream) {
            stream.accept(pcm)
            const text = stream.finish().trim()
            stream = null
            preRoll = new Float32Array(0)
            send({ type: 'final', text })
        }
    })
}

export async function startVoiceService(options: VoiceServiceOptions): Promise<VoiceServiceHandle> {
    const { engine } = options
    const convert = options.convert || ffmpegConvert
    const info = engine.describe()
    const server: Server = createServer(async (req, res) => {
        if (!voicePeerAllowed(req.socket.remoteAddress)) return void json(res, 403, { error: 'nur aus dem eigenen Netz' })
        const path = String(req.url || '').split('?')[0]
        try {
            if (req.method === 'GET' && path === '/health') {
                return void json(res, 200, { service: VOICE_SERVICE_NAME, version: 1, ok: true, capabilities: ['stt', 'tts', 'stream'], stt: info.stt, voices: info.voices, sampleRate: VOICE_SAMPLE_RATE })
            }
            if (req.method === 'POST' && path === '/v1/transcribe') {
                const body = await readBody(req, MAX_AUDIO_BYTES)
                const samples = await toPcm16k(body, String(req.headers['content-type'] || ''), convert)
                return void json(res, 200, { text: engine.transcribe(samples).trim(), durationSec: Math.round(samples.length / VOICE_SAMPLE_RATE * 100) / 100 })
            }
            if (req.method === 'POST' && path === '/v1/speak') {
                const input = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
                const text = String(input?.text || '').trim()
                if (!text || text.length > MAX_TEXT) return void json(res, 400, { error: 'Text fehlt oder ist zu lang' })
                const voice: VoiceName = input?.voice === 'male' ? 'male' : 'female'
                const audio = engine.synthesize(text, voice)
                const wav = encodeWav(audio.samples, audio.sampleRate)
                const duration = (audio.samples.length / audio.sampleRate).toFixed(3)
                if (input?.format === 'ogg') {
                    const ogg = await convert(wav, ['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'])
                    res.writeHead(200, { 'Content-Type': 'audio/ogg', 'X-Duration-Sec': duration, 'Cache-Control': 'no-store' })
                    return void res.end(ogg)
                }
                res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Duration-Sec': duration, 'Cache-Control': 'no-store' })
                return void res.end(wav)
            }
            json(res, 404, { error: 'unbekannt' })
        } catch (error) {
            json(res, 400, { error: String((error as Error)?.message || error).slice(0, 200) })
        }
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
    server.on('upgrade', (req, socket, head) => {
        if (!voicePeerAllowed(req.socket.remoteAddress) || String(req.url || '').split('?')[0] !== '/v1/stream') { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => attachStream(ws, engine))
    })
    const host = options.host || '127.0.0.1'
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? VOICE_SERVICE_PORT, host, () => resolve()) })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : (options.port ?? VOICE_SERVICE_PORT)
    return {
        port, host,
        close: async () => {
            for (const client of wss.clients) client.terminate()
            wss.close()
            server.closeAllConnections?.()
            await new Promise<void>(resolve => server.close(() => resolve()))
        },
    }
}

// ------------------------------------------------------------------ echte Modelle (sherpa-onnx)

/** Lädt das installierte Bündel (voice-artifacts.ts) mit sherpa-onnx für Node. */
export async function loadSherpaEngine(dir?: string): Promise<VoiceEngine> {
    const { voiceBundleLayout, voiceBundleDir } = await import('./voice-artifacts.js')
    const layout = voiceBundleLayout(dir || voiceBundleDir())
    const sherpa = createRequire(import.meta.url)(layout.runtime) as any
    const asrConfig = {
        featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
        modelConfig: { transducer: { encoder: layout.asr.encoder, decoder: layout.asr.decoder, joiner: layout.asr.joiner }, tokens: layout.asr.tokens, numThreads: 4, provider: 'cpu' },
        decodingMethod: 'greedy_search', enableEndpoint: 0,
    }
    const recognizer = new sherpa.OnlineRecognizer(asrConfig)
    const voices = Object.fromEntries((['female', 'male'] as VoiceName[]).map(name => [name, new sherpa.OfflineTts({
        model: { vits: { model: layout.voices[name].model, tokens: layout.voices[name].tokens, dataDir: layout.voices[name].dataDir }, numThreads: 4, provider: 'cpu' },
        maxNumSentences: 1,
    })])) as Record<VoiceName, any>
    const decodeAll = (stream: any) => { while (recognizer.isReady(stream)) recognizer.decode(stream) }
    const newStream = () => {
        const stream = recognizer.createStream()
        try { stream.setOption('language', 'de') } catch { /* älteres Modell */ }
        return stream
    }
    const flush = (stream: any) => {
        // Kurzer Null-Nachlauf leert den Transducer ohne künstliche Wartezeit (Voice-Lab).
        stream.acceptWaveform({ samples: new Float32Array(8960), sampleRate: VOICE_SAMPLE_RATE })
        decodeAll(stream)
        stream.inputFinished()
        decodeAll(stream)
        return String(recognizer.getResult(stream)?.text || '').trim()
    }
    return {
        describe: () => ({ stt: 'Nemotron 3.5 Streaming 0.6B INT8 (560 ms)', voices: { female: layout.voices.female.label, male: layout.voices.male.label } }),
        createVad: () => {
            const vad = new sherpa.Vad({ sileroVad: { model: layout.vad, ...VAD_SETTINGS }, sampleRate: VOICE_SAMPLE_RATE, numThreads: 1, provider: 'cpu' }, 30)
            return {
                accept: samples => { vad.acceptWaveform(samples); while (!vad.isEmpty()) vad.pop() },
                speech: () => Boolean(vad.isDetected()),
                reset: () => vad.reset(),
            }
        },
        createStream: () => {
            const stream = newStream()
            return {
                accept: samples => { stream.acceptWaveform({ samples, sampleRate: VOICE_SAMPLE_RATE }); decodeAll(stream) },
                partial: () => String(recognizer.getResult(stream)?.text || ''),
                finish: () => flush(stream),
            }
        },
        synthesize: (text, voice) => {
            const audio = voices[voice].generate({ text, sid: 0, speed: 1.0 })
            return { samples: Float32Array.from(audio.samples), sampleRate: audio.sampleRate }
        },
        transcribe: samples => {
            const stream = newStream()
            stream.acceptWaveform({ samples, sampleRate: VOICE_SAMPLE_RATE })
            decodeAll(stream)
            return flush(stream)
        },
    }
}

/** Tailnet-Adresse dieses Rechners (100.64.0.0/10), sonst 127.0.0.1. */
export function defaultVoiceBindHost(interfaces = networkInterfaces()): string {
    const override = String(process.env.XAVENTRA_VOICE_BIND || '').trim()
    if (override && isPrivateVoiceHost(override)) return override
    for (const list of Object.values(interfaces)) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(entry.address)) return entry.address
        }
    }
    return '127.0.0.1'
}

let running: VoiceServiceHandle | null = null

/**
 * Startet den Sprachdienst, wenn das Bündel installiert und geprüft ist
 * (Werkzeugkasten-Knopf „Lokaler Sprachdienst“). Ohne Bündel: still nichts.
 */
export async function maybeStartVoiceService(): Promise<VoiceServiceHandle | null> {
    if (running || process.env.XAVENTRA_VOICE_SERVICE === '0' || process.platform !== 'linux') return running
    try {
        const { verifyVoiceBundle } = await import('./voice-artifacts.js')
        await verifyVoiceBundle()
    } catch { return null }
    try {
        const engine = await loadSherpaEngine()
        running = await startVoiceService({ engine, host: defaultVoiceBindHost() })
        console.log(`[Voice] Sprachdienst läuft auf ${running.host}:${running.port}`)
        return running
    } catch (error) {
        console.warn(`[Voice] Sprachdienst nicht gestartet: ${String((error as Error)?.message || error).slice(0, 200)}`)
        return null
    }
}

export async function stopVoiceService(): Promise<void> {
    const handle = running
    running = null
    await handle?.close()
}
