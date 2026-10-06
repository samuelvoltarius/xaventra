/**
 * 2.86 Paket O: Sprache in der App — Einstellung, Status und „Anrufen“.
 *
 *   GET   /api/desktop/sprache          Sprachdienst gefunden? Owner-Einstellung, sonst Knopf
 *   PATCH /api/desktop/sprache          { replyByVoice?, voice? } (nur Owner)
 *   POST  /api/desktop/sprache/anruf    Einmal-Ticket (60 s) für den Anruf-WebSocket (nur Owner)
 *   WS    /api/desktop/sprache/anruf/ws?ticket=…   Browser ⇄ Main ⇄ Sprachdienst
 *
 * Browser können einem WebSocket keinen Authorization-Kopf mitgeben; darum
 * holt die App mit dem Desktop-Token ein kurzes Einmal-Ticket. Das Token selbst
 * steht nie in einer Adresse.
 *
 * Ablauf eines Anrufs: Der Sprachdienst hört (VAD + Pre-Roll + Partials +
 * Endtext), der Main fragt die Pipeline (Gedächtnis, Werkzeuge, Regeln).
 * 2.87 Paket P: die Antwort wird wortweise gesprochen, während sie entsteht;
 * einfache Fragen (Uhrzeit, Datum, „läuft alles?“) kommen ohne Modellrunde.
 * Dazwischenreden bricht Antwort, Werkzeugrunde und Sprachausgabe ab.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Express, Request } from 'express'
import { VoiceCallSession, type SpokenAudio, type VoiceAnswerStream, type VoiceCallDeps, type VoiceName } from '../voice/voice-call.js'
import { runWithVoiceTurn } from '../voice/voice-turn-stream.js'
import { createVoiceAnswerer } from '../voice/voice-quick.js'
import { discoverVoiceService, VoiceServiceClient } from '../voice/voice-mesh.js'
import { readVoicePrefs, writeVoicePrefs } from '../voice/voice-prefs.js'

export const VOICE_CALL_PATH = '/api/desktop/sprache/anruf/ws'
const TICKET_TTL_MS = 60_000
const MAX_TICKETS = 32
const MAX_SPOKEN_CHARS = 600

interface DiscoveredVoice { endpoint: string; sourceNode?: string; host?: string }
type Discover = () => Promise<DiscoveredVoice | null>

export interface VoiceTicketContext { principalId: string; clientId: string }
const tickets = new Map<string, VoiceTicketContext & { expiresAt: number }>()

export function issueVoiceTicket(context: VoiceTicketContext, now: () => number = Date.now): string {
    for (const [key, value] of tickets) if (value.expiresAt <= now()) tickets.delete(key)
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string)
    const ticket = randomBytes(32).toString('base64url')
    tickets.set(ticket, { ...context, expiresAt: now() + TICKET_TTL_MS })
    return ticket
}

/** Einmal gültig; danach und nach 60 s nie wieder. */
export function consumeVoiceTicket(ticket: unknown, now: () => number = Date.now): VoiceTicketContext | null {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null
    for (const [key, value] of tickets) {
        const a = Buffer.from(key), b = Buffer.from(ticket)
        if (a.length === b.length && timingSafeEqual(a, b)) {
            tickets.delete(key)
            return value.expiresAt > now() ? { principalId: value.principalId, clientId: value.clientId } : null
        }
    }
    return null
}

export async function voiceStatus(discover: Discover = discoverVoiceService) {
    const service = await discover().catch(() => null)
    const einstellung = readVoicePrefs()
    if (!service) {
        return {
            dienst: { gefunden: false },
            einstellung,
            knopf: { katalogId: 'sprachdienst:de', text: 'Sprachdienst einrichten' },
            text: 'Zum Sprechen mit mir fehlt noch der lokale Sprachdienst. Mit einem Knopf richte ich ihn auf einem passenden Rechner ein – deine Stimme bleibt dabei in deinem eigenen Netz.',
        }
    }
    return {
        dienst: { gefunden: true, knoten: String(service.sourceNode && service.sourceNode !== 'local' ? service.sourceNode : 'diesem Rechner') },
        einstellung,
        text: 'Du kannst mich anrufen. Sprich einfach los – Pausen beenden deinen Satz, Dazwischenreden unterbricht mich.',
    }
}

export interface VoiceApiHelpers {
    isOwner: (req: Request) => boolean
    principal: (req: Request) => string
    clientId: (req: Request) => string
    discover?: Discover
}

export function registerVoiceApi(app: Express, helpers: VoiceApiHelpers): void {
    const discover = helpers.discover || discoverVoiceService
    app.get('/api/desktop/sprache', async (_req, res) => { res.json(await voiceStatus(discover)) })
    app.patch('/api/desktop/sprache', (req, res) => {
        if (!helpers.isOwner(req)) return void res.status(403).json({ error: 'Nur der Besitzer kann das ändern.' })
        const body = req.body || {}
        const einstellung = writeVoicePrefs({
            ...(typeof body.replyByVoice === 'boolean' ? { replyByVoice: body.replyByVoice } : {}),
            ...(body.voice === 'male' || body.voice === 'female' ? { voice: body.voice } : {}),
        })
        res.json({ einstellung })
    })
    app.post('/api/desktop/sprache/anruf', (req, res) => {
        if (!helpers.isOwner(req)) return void res.status(403).json({ error: 'Anrufen kann nur der Besitzer.' })
        const ticket = issueVoiceTicket({ principalId: helpers.principal(req), clientId: helpers.clientId(req) })
        res.json({ ticket, pfad: VOICE_CALL_PATH, gueltigSek: TICKET_TTL_MS / 1000 })
    })
}

// ------------------------------------------------------------------ Brücke

interface SocketLike {
    readyState: number
    OPEN?: number
    send(data: unknown): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
    on(event: 'close' | 'open', listener: () => void): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
}

export interface VoiceCallBridgeDeps {
    discover: Discover
    openUpstream: (url: string) => SocketLike
    answer: VoiceCallDeps['answer']
    voice: VoiceName
    speak?: (text: string, voice: VoiceName, signal: AbortSignal) => Promise<SpokenAudio>
}

export async function runVoiceCallBridge(browser: SocketLike, deps: VoiceCallBridgeDeps): Promise<void> {
    const sendBrowser = (event: Record<string, unknown>) => { if (browser.readyState === (browser.OPEN ?? 1)) browser.send(JSON.stringify(event)) }
    const service = await deps.discover().catch(() => null)
    if (!service) {
        sendBrowser({ type: 'notice', setup: true, text: 'Zum Anrufen fehlt noch der lokale Sprachdienst. Richte ihn mit dem Knopf ein – dann geht es los.' })
        browser.close(1000, 'kein Sprachdienst')
        return
    }
    const client = new VoiceServiceClient(service.endpoint)
    const session = new VoiceCallSession({
        answer: deps.answer,
        speak: deps.speak || ((text, voice, signal) => client.speak(text, voice, 'wav', signal)),
        emit: event => sendBrowser(event as unknown as Record<string, unknown>),
        voice: deps.voice,
        maxSpokenChars: MAX_SPOKEN_CHARS,
    })
    let ended = false
    let upstream: SocketLike | null = null
    const end = (notice?: string) => {
        if (ended) return
        ended = true
        session.stop()
        if (notice) sendBrowser({ type: 'notice', text: notice })
        try { upstream?.close() } catch { /* schon zu */ }
        try { browser.close(1000) } catch { /* schon zu */ }
    }
    sendBrowser({ type: 'ready', voice: deps.voice })
    upstream = deps.openUpstream(client.streamUrl())
    upstream.on('message', (raw, isBinary) => {
        if (isBinary) return
        let event: any
        try { event = JSON.parse(String(raw)) } catch { return }
        if (event?.type === 'speech_start') void session.onSpeechStart()
        else if (event?.type === 'partial') void session.onPartial(String(event.text || '').slice(0, 2000))
        else if (event?.type === 'final') void session.onFinal(String(event.text || '').slice(0, 4000))
    })
    upstream.on('close', () => end('Die Verbindung zum Sprachdienst ist weg. Ruf mich gleich noch einmal an.'))
    upstream.on('error', () => end('Die Verbindung zum Sprachdienst ist weg. Ruf mich gleich noch einmal an.'))
    browser.on('message', (raw, isBinary) => {
        if (isBinary) {
            if (upstream && upstream.readyState === (upstream.OPEN ?? 1) && raw.length <= 64 * 1024) upstream.send(raw)
            return
        }
        let event: any
        try { event = JSON.parse(String(raw)) } catch { return }
        if (event?.type === 'voice') session.setVoice(event.voice)
        else if (event?.type === 'cancel') session.cancel()
        else if (event?.type === 'stop') end()
    })
    browser.on('close', () => end())
    browser.on('error', () => end())
}

// ------------------------------------------------------------------ Pipeline + WebSocket-Upgrade

type MessageHandler = (message: string, channel: string) => Promise<string>

/**
 * Antwort aus der echten Pipeline, im Gesprächsraum „Anruf“ (Verlauf steht danach
 * in der Unterhaltung). Mit `stream` meldet die Pipeline unterwegs Textstücke und
 * Werkzeugrunden (2.87 Paket P, request-lokal, nur in diesem Sprach-Zug).
 */
export interface PipelineAnswerOptions {
    /** Wer handelt (Rechte). App-Anruf: `desktop:<owner>` als Owner. Telefon: `telefon:<nummer>`. */
    authorizationUserId?: string
    /** Telefon: 'user' — eine Rufnummer ist kein Owner-Nachweis. */
    permission?: 'owner' | 'user'
    roomTitle?: string
    roomTopic?: string
}

export function pipelineAnswer(context: VoiceTicketContext, resolveHandler: () => MessageHandler | null, options: PipelineAnswerOptions = {}) {
    return async (text: string, signal: AbortSignal, stream?: VoiceAnswerStream): Promise<string> => {
        const handler = resolveHandler()
        if (!handler) throw new Error('Pipeline noch nicht bereit')
        const [{ getTopicRoomStore }, { runWithDesktopAgentContext }, { getOrCreateUser, setUserPermission }] = await Promise.all([
            import('./topic-room-store.js'), import('./desktop-agent-context.js'), import('../users/multi-user-middleware.js'),
        ])
        const store = getTopicRoomStore()
        const owner = context.principalId
        const roomTitle = options.roomTitle || 'Anruf'
        const room = store.listRooms(owner).find(item => item.title === roomTitle) || store.createRoom(owner, { title: roomTitle, topic: options.roomTopic || 'Gespräche per Sprache', botIds: ['nova'] } as any)
        store.addMessage(owner, room.id, { authorType: 'user', authorId: owner, content: text, verifiedEvidence: 0 } as any)
        const authorizationUserId = options.authorizationUserId || `desktop:${owner}`
        getOrCreateUser(authorizationUserId, 'desktop', owner)
        // App: das Ticket gibt es nur gegen das Desktop-Owner-Token (registerVoiceApi prüft isOwner).
        // Telefon: Rufnummern lassen sich fälschen → nie Owner-Rechte.
        setUserPermission(authorizationUserId, options.permission || 'owner')
        const run = () => runWithDesktopAgentContext({
            abortSignal: signal, principalId: owner, clientId: context.clientId, authorizationUserId,
            roomId: room.id, botId: 'nova', preferredNodeIds: [], modelMode: 'auto', memoryAssetIds: [],
        }, () => handler(text, 'desktop'))
        const reply = stream ? await runWithVoiceTurn({
            onTextDelta: delta => stream.onTextDelta(delta),
            onToolRound: names => stream.onToolRound(names),
            onToolDone: (name, ok) => stream.onToolDone?.(name, ok),
        }, run) : await run()
        if (!signal.aborted) store.addMessage(owner, room.id, { authorType: 'bot', authorId: 'nova', content: reply, verifiedEvidence: 0 } as any)
        return reply
    }
}

export interface VoiceUpgradeDeps {
    allowedHost: (host: string | undefined) => boolean
    sameOrigin: (host: string | undefined, origin: string | undefined) => boolean
    resolveHandler: () => MessageHandler | null
}

let upgradeServer: import('ws').WebSocketServer | null = null

/** true = dieser Upgrade gehört zum Anruf (beantwortet oder abgelehnt). */
export async function handleVoiceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: VoiceUpgradeDeps): Promise<boolean> {
    const url = new URL(String(req.url || '/'), 'http://localhost')
    if (url.pathname !== VOICE_CALL_PATH) return false
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    const context = deps.allowedHost(req.headers.host) && deps.sameOrigin(req.headers.host, origin) ? consumeVoiceTicket(url.searchParams.get('ticket')) : null
    if (!context) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return true
    }
    const { WebSocketServer, WebSocket } = await import('ws')
    upgradeServer ||= new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
    const { productionQuickDeps } = await import('../voice/voice-quick-runtime.js')
    const quick = await productionQuickDeps()
    upgradeServer.handleUpgrade(req, socket, head, ws => {
        void runVoiceCallBridge(ws as unknown as SocketLike, {
            discover: discoverVoiceService,
            openUpstream: target => new WebSocket(target, { perMessageDeflate: false, maxPayload: 256 * 1024 }) as unknown as SocketLike,
            // Das Ticket gibt es nur gegen das Owner-Token: hier ist ein gesprochenes „ja“ eine Owner-Antwort.
            answer: createVoiceAnswerer({ pipeline: pipelineAnswer(context, deps.resolveHandler), quick, ownerAuthenticated: true }),
            voice: readVoicePrefs().voice,
        })
    })
    return true
}
