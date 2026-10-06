/**
 * 2.87 Paket P: Telefon über eine vorhandene Telefonanlage (Asterisk).
 *
 * Die Anlage bleibt der SIP-/RTP-Teil (Anbieter, Codecs, NAT). Xaventra
 * bekommt das Gespräch nur lokal:
 *
 *   1. Anlage fragt  GET http://127.0.0.1:<anmeldePort>/anruf?nummer=<Anrufer>
 *      → Antwort: eine Einmal-Kennung (UUID, 30 s gültig). Ob die Nummer eine
 *        Owner-Nummer ist, entscheidet NUR Xaventra.
 *   2. Anlage verbindet AudioSocket(<Kennung>, 127.0.0.1:<audioSocketPort>).
 *      Owner-Nummer → Gespräch (Sprachdienst hört, Pipeline antwortet, Barge-in).
 *      Andere/unterdrückte Nummer → eine höfliche Ansage, dann auflegen
 *      (kein Zuhören, keine Pipeline).
 *
 * Beide Ports lauschen ausschließlich auf 127.0.0.1 und nur, wenn der Owner das
 * Telefon eingerichtet und eingeschaltet hat (telefonBereit). Rufnummern lassen
 * sich fälschen: ein Telefonanruf gilt darum nie als Owner-Nachweis — Wirkungen
 * gehen weiter nur über Karten in App/Telegram.
 */
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { AS_AUDIO, AS_HANGUP, AS_UUID, encodeFrame, FrameReader, PHONE_RATE, phoneFrames, resamplePcm16, uuidFromBytes, wavToPcm16 } from './audiosocket.js'
import { VoiceCallSession, type SpokenAudio, type VoiceCallDeps, type VoiceName } from './voice-call.js'
import { VOICE_SAMPLE_RATE } from './voice-contract.js'
import { VoiceServiceClient } from './voice-mesh.js'
import { isOwnerNumber, normalizeNumber, telefonBereit, type TelefonConfig } from './telefon-config.js'

export const REJECT_TEXT = 'Guten Tag. Unter dieser Nummer kann ich Ihren Anruf leider nicht annehmen. Auf Wiederhören.'
export const GREETING_TEXT = 'Hallo, ich höre dir zu.'
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 32
const MAX_CALL_MS = 30 * 60_000
const UUID_WAIT_MS = 5_000
const MAX_SPOKEN_CHARS = 600

interface SocketLike {
    readyState: number
    OPEN?: number
    send(data: unknown): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
    on(event: 'close' | 'open', listener: () => void): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
}

export interface TelefonBridgeDeps {
    discover: () => Promise<{ endpoint: string } | null>
    openUpstream: (url: string) => SocketLike
    /** Antwortfunktion für einen erlaubten Anrufer (normalisierte Nummer). */
    answerFor: (caller: string) => VoiceCallDeps['answer']
    voice: VoiceName
    /** Sprachausgabe; Standard: der gefundene Sprachdienst. */
    speak?: (text: string, voice: VoiceName, signal: AbortSignal) => Promise<SpokenAudio>
    frameIntervalMs?: number
    now?: () => number
    log?: (line: string) => void
    /** Nur zum Testen: wird nie aufgerufen, solange das Telefon nicht bereit ist. */
    createServers?: () => unknown
}

export interface TelefonBridge {
    addresses: { audioSocket: AddressInfo; anmeldung: AddressInfo }
    stop(): Promise<void>
}

interface Ticket { caller: string; allowed: boolean; expiresAt: number }

/** Ausgehende Anrufe, die Xaventra gerade selbst wählt (Owner-Nummer oder bestätigte Karte). */
const outbound = new Map<string, number>()
const OUTBOUND_TTL_MS = 2 * 60_000

/** Vor dem Wählen: genau diese Nummer darf gleich als Gespräch zurückkommen (einmal, 2 Minuten). */
export function allowOutbound(number: string, now: () => number = Date.now): void {
    const key = normalizeNumber(number)
    for (const [item, until] of outbound) if (until <= now()) outbound.delete(item)
    if (key) outbound.set(key, now() + OUTBOUND_TTL_MS)
}

function takeOutbound(number: string, now: () => number): boolean {
    const until = outbound.get(number)
    outbound.delete(number)
    return Boolean(until && until > now())
}

const isLoopback = (address: string | undefined) => /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(address || ''))

/** Startet die Brücke nur mit fertiger Owner-Konfiguration; sonst null (nichts lauscht). */
export async function startTelefonIfReady(config: TelefonConfig, deps: TelefonBridgeDeps): Promise<TelefonBridge | null> {
    if (!telefonBereit(config)) return null
    deps.createServers?.()
    return startTelefonBridge(config, deps)
}

function listen(server: HttpServer | NetServer, port: number): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address() as AddressInfo) })
    })
}

export async function startTelefonBridge(config: TelefonConfig, deps: TelefonBridgeDeps): Promise<TelefonBridge> {
    const now = deps.now || Date.now
    const log = deps.log || (() => undefined)
    const tickets = new Map<string, Ticket>()
    const calls = new Set<() => void>()

    const anmeldung = createHttpServer((req, res) => {
        const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
        if (!isLoopback(req.socket.remoteAddress) || req.method !== 'GET' || url.pathname !== '/anruf') {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end()
            return
        }
        for (const [key, value] of tickets) if (value.expiresAt <= now()) tickets.delete(key)
        while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string)
        const caller = normalizeNumber(url.searchParams.get('nummer') || '')
        // Eingehend: nur Owner-Nummern. Ausgehend: nur was Xaventra gerade selbst gewählt hat.
        const allowed = url.searchParams.get('richtung') === 'raus' ? takeOutbound(caller, now) : isOwnerNumber(caller, config.ownerNummern)
        const id = randomUUID()
        tickets.set(id, { caller, allowed, expiresAt: now() + TICKET_TTL_MS })
        // Im Log nie die volle Nummer.
        log(`[Telefon] Anruf ${allowed ? 'von Owner-Nummer' : 'von fremder Nummer (wird abgelehnt)'}${caller ? ` …${caller.slice(-3)}` : ''}`)
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(id)
    })

    const audio = createNetServer(socket => {
        if (!isLoopback(socket.remoteAddress)) { socket.destroy(); return }
        handleConnection(socket)
    })

    function takeTicket(id: string): Ticket | null {
        const ticket = id ? tickets.get(id) : undefined
        if (!ticket) return null
        tickets.delete(id)
        return ticket.expiresAt > now() ? ticket : null
    }

    function handleConnection(socket: Socket): void {
        const reader = new FrameReader()
        let started = false
        let onAudio: ((pcm8k: Buffer) => void) | null = null
        let finish: (() => void) | null = null
        const hangup = () => {
            if (!socket.destroyed) { try { socket.end(encodeFrame(AS_HANGUP)) } catch { /* schon zu */ } }
        }
        const waitUuid = setTimeout(() => { if (!started) { hangup(); socket.destroy() } }, UUID_WAIT_MS)
        socket.on('data', chunk => {
            let frames
            try { frames = reader.push(chunk) } catch { hangup(); return }
            for (const frame of frames) {
                if (!started) {
                    if (frame.type !== AS_UUID) { hangup(); return }
                    started = true
                    clearTimeout(waitUuid)
                    const ticket = takeTicket(uuidFromBytes(frame.payload))
                    if (!ticket) { hangup(); return }
                    const call = ticket.allowed ? runConversation(socket, ticket.caller, hangup) : runRejection(socket, hangup)
                    onAudio = call.onAudio
                    finish = call.finish
                    calls.add(call.finish)
                } else if (frame.type === AS_AUDIO) onAudio?.(frame.payload)
                else if (frame.type === AS_HANGUP || frame.type === 0xff) { finish?.(); socket.end() }
            }
        })
        socket.on('error', () => finish?.())
        socket.on('close', () => { clearTimeout(waitUuid); finish?.(); if (finish) calls.delete(finish) })
    }

    /** Spielt PCM 8 kHz im 20-ms-Takt in die Leitung. */
    function createPlayer(socket: Socket) {
        const queue: Buffer[] = []
        const timer = setInterval(() => {
            const frame = queue.shift()
            if (frame && !socket.destroyed) socket.write(encodeFrame(AS_AUDIO, frame))
        }, deps.frameIntervalMs ?? 20)
        timer.unref?.()
        return {
            playWav(data: Buffer) {
                const { pcm, sampleRate } = wavToPcm16(data)
                queue.push(...phoneFrames(resamplePcm16(pcm, sampleRate, PHONE_RATE)))
            },
            clear() { queue.length = 0 },
            idle: () => queue.length === 0,
            stop() { clearInterval(timer); queue.length = 0 },
        }
    }

    async function speaker(): Promise<{ speak: NonNullable<TelefonBridgeDeps['speak']>; endpoint: string } | null> {
        const service = await deps.discover().catch(() => null)
        if (!service) return null
        const client = new VoiceServiceClient(service.endpoint)
        return { endpoint: service.endpoint, speak: deps.speak || ((text, voice, signal) => client.speak(text, voice, 'wav', signal)) }
    }

    function runRejection(socket: Socket, hangup: () => void) {
        const controller = new AbortController()
        const player = createPlayer(socket)
        let done = false
        const finish = () => { if (done) return; done = true; controller.abort(); player.stop() }
        void (async () => {
            try {
                const voice = await speaker()
                if (voice && !controller.signal.aborted) {
                    const spoken = await voice.speak(REJECT_TEXT, deps.voice, controller.signal)
                    player.playWav(spoken.audio)
                    while (!player.idle() && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, deps.frameIntervalMs ?? 20))
                }
            } catch { /* ohne Sprachdienst: einfach auflegen */ }
            finish()
            hangup()
        })()
        return { onAudio: () => undefined, finish }
    }

    function runConversation(socket: Socket, caller: string, hangup: () => void) {
        const player = createPlayer(socket)
        let upstream: SocketLike | null = null
        let session: VoiceCallSession | null = null
        let done = false
        const maxTimer = setTimeout(() => { finish(); hangup() }, MAX_CALL_MS)
        maxTimer.unref?.()
        const finish = () => {
            if (done) return
            done = true
            clearTimeout(maxTimer)
            session?.stop()
            player.stop()
            try { upstream?.close() } catch { /* schon zu */ }
        }
        void (async () => {
            const voice = await speaker()
            if (!voice || done) { finish(); hangup(); return }
            session = new VoiceCallSession({
                answer: deps.answerFor(caller),
                speak: voice.speak,
                voice: deps.voice,
                maxSpokenChars: MAX_SPOKEN_CHARS,
                emit: event => {
                    if (event.type === 'audio') { try { player.playWav(Buffer.from(event.data, 'base64')) } catch { /* kaputtes Audio überspringen */ } }
                    else if (event.type === 'cancelled' || event.type === 'speech_start') player.clear()
                },
            })
            upstream = deps.openUpstream(new VoiceServiceClient(voice.endpoint).streamUrl())
            upstream.on('message', (raw, isBinary) => {
                if (isBinary || !session) return
                let event: any
                try { event = JSON.parse(String(raw)) } catch { return }
                if (event?.type === 'speech_start') void session.onSpeechStart()
                else if (event?.type === 'partial') void session.onPartial(String(event.text || '').slice(0, 2000))
                else if (event?.type === 'final') void session.onFinal(String(event.text || '').slice(0, 4000))
            })
            upstream.on('close', () => { if (!done) { finish(); hangup() } })
            upstream.on('error', () => { if (!done) { finish(); hangup() } })
            try {
                const hello = await voice.speak(GREETING_TEXT, deps.voice, new AbortController().signal)
                session.noteAssistantText(GREETING_TEXT)
                if (!done) player.playWav(hello.audio)
            } catch { /* ohne Begrüßung weiter */ }
        })()
        return {
            onAudio: (pcm8k: Buffer) => {
                if (!upstream || upstream.readyState !== (upstream.OPEN ?? 1) || pcm8k.length > 4096) return
                upstream.send(resamplePcm16(pcm8k, PHONE_RATE, VOICE_SAMPLE_RATE))
            },
            finish,
        }
    }

    const [audioAddress, anmeldeAddress] = await Promise.all([listen(audio, config.asterisk.audioSocketPort), listen(anmeldung, config.asterisk.anmeldePort)])
    log(`[Telefon] bereit: AudioSocket 127.0.0.1:${audioAddress.port}, Anmeldung 127.0.0.1:${anmeldeAddress.port}`)
    return {
        addresses: { audioSocket: audioAddress, anmeldung: anmeldeAddress },
        async stop() {
            for (const finish of calls) finish()
            calls.clear()
            await Promise.all([
                new Promise<void>(resolve => audio.close(() => resolve())),
                new Promise<void>(resolve => { anmeldung.closeAllConnections?.(); anmeldung.close(() => resolve()) }),
            ])
        },
    }
}
