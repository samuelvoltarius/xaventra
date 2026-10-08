/**
 * Kanal Even G2 (Autonomie-Plan Phase 5a): the smart glasses talk to
 * Xaventra directly.
 *
 * 1. Even-AI endpoint ("Hey Even" → Even App "Add Agent" → URL + token):
 *    `POST /` with an OpenAI-like body `{ model, messages: [{ role, content }] }`,
 *    answered with a non-streamed `chat.completion`. The Even App sends every
 *    question twice (hedged request) and waits ~28 s; the reply is shown as
 *    plain text (~400 characters, no Markdown).
 * 2. HUD feed for an Even-Hub app: `GET /hud` (long-poll with `since`/`wait`)
 *    returns the live status line and open Knopf-Karten as short texts;
 *    `POST /hud/answer { cardId, answer: 'ja' | 'nein' }` (tap / double tap)
 *    goes through `answerApprovalCard`.
 * 3. Voice for the HUD app: `POST /hud/voice` takes the G2 microphone audio
 *    (16 kHz / 16 bit / mono, raw PCM or WAV), transcribes it with the
 *    existing Xaventra STT and either answers the shown card with a strict
 *    ja/nein recognizer or hands the sentence to the agent like `POST /`.
 *    Speech never confirms a card that needs an explicit confirm step.
 *
 * Rules (fixed in code):
 * - Off by default (`channels.evenG2.enabled=true` plus `NOVA_EVEN_G2_TOKEN`).
 * - Never on a worker (`NOVA_NODE_ONLY=true`); every effect asks the Main
 *   fence (503 when fenced in enforce mode).
 * - Binds to 127.0.0.1 only. Remote access goes through `tailscale serve`
 *   (HTTPS, tailnet only) — see docs/EVEN_G2.md.
 * - Owner token compared in constant time, never logged or echoed.
 * - Same question within the dedupe window → one pipeline run, same answer.
 * - Time budget below the Even deadline; slower answers get a short interim
 *   reply and the result goes to Telegram (exactly once).
 * - Cards: only 'ja'/'nein', never 'immer'; the button tokens stay on the
 *   server, the glasses only know card ids.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { answerApprovalCard, listApprovalCards, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'

export const EVEN_G2_CHANNEL = 'even-g2'
export const EVEN_G2_PRINCIPAL = 'even-g2:owner'
export const EVEN_G2_DEFAULT_PORT = 18790
export const EVEN_G2_HOST = '127.0.0.1'
/** Even App deadline is ~28 s; stay clearly below. */
export const DEFAULT_BUDGET_MS = 24_000
export const DEFAULT_DEDUPE_MS = 30_000
export const MAX_REPLY_CHARS = 400
export const INTERIM_REPLY = 'Ich arbeite dran, Ergebnis kommt in Telegram.'
const MIN_TOKEN_LENGTH = 24
const MAX_BODY_BYTES = 64 * 1024
const MAX_QUESTION_CHARS = 2_000
const DEFAULT_MAX_RUN_MS = 10 * 60_000
const MAX_LONG_POLL_MS = 25_000

/** G2 microphone format: 16 kHz, 16 bit, mono. */
export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2
export const VOICE_MAX_SECONDS = 20
/** Total body cap (PCM plus WAV header slack). */
export const VOICE_MAX_BODY_BYTES = 700_000
/** Below this the clip is a tap, not speech. */
export const VOICE_MIN_BYTES = Math.round(VOICE_BYTES_PER_SECOND * 0.3)
export const DEFAULT_STT_TIMEOUT_MS = 12_000
const MAX_TRANSCRIPT_CHARS = 500

export interface EvenG2Settings { port: number; allowOrigins: string[] }
export interface EvenG2Resolution { start: boolean; reason: string; settings?: EvenG2Settings; token?: string }

export interface HudCard { id: string; titel: string; text: string; wirkung: string; antworten: Array<'ja' | 'nein'>; gueltigBis: string }
export interface HudSnapshot { version: string; status: string; cards: HudCard[]; at: string }
export interface CardAnswerHttp { status: number; body: Record<string, unknown> }

/** Thrown by `EvenG2Deps.transcribe` when no speech recognition is reachable. */
export class EvenG2SttUnavailableError extends Error {
    constructor(message = 'Spracherkennung nicht verfügbar.') { super(message) }
}

export type VoiceAction = 'answered_ja' | 'answered_nein' | 'needs_confirm' | 'message' | 'none'

export interface EvenG2Deps {
    token: string
    /** Runs the normal message pipeline (channel even-g2, owner principal) and returns the final reply. */
    ask(question: string, signal: AbortSignal): Promise<string>
    /** Delivers an answer that missed the time budget (Telegram). */
    overflow(question: string, answer: string): Promise<void>
    /** Throws when this node may not act as Main (fenced). */
    fence(effect: string): Promise<void>
    hudSnapshot(): Promise<HudSnapshot>
    answerCard(cardId: string, answer: 'ja' | 'nein'): Promise<CardAnswerHttp>
    /**
     * Speech to text for /hud/voice. Gets a 16 kHz mono PCM16 WAV; returns the
     * transcript, throws `EvenG2SttUnavailableError` when no STT is reachable.
     * Missing = voice disabled (503).
     */
    transcribe?(wav: Buffer, opts: { durationSec: number; signal: AbortSignal }): Promise<string>
    sttTimeoutMs?: number
    allowOrigins?: string[]
    now?: () => number
    budgetMs?: number
    dedupeMs?: number
    maxRunMs?: number
    pollIntervalMs?: number
}

export interface EvenG2Server { server: Server; port: number; close(): Promise<void> }

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** Off unless enabled=true AND a token is set; never on a worker. The configured host is ignored. */
export function resolveEvenG2Settings(config: any, env: NodeJS.ProcessEnv = process.env): EvenG2Resolution {
    const raw = config?.channels?.evenG2
    if (String(env.NOVA_NODE_ONLY || '').toLowerCase() === 'true') return { start: false, reason: 'Worker-Knoten: Even G2 nur am Main' }
    if (!raw || raw.enabled !== true) return { start: false, reason: 'aus (channels.evenG2.enabled ist nicht true)' }
    const token = String(env.NOVA_EVEN_G2_TOKEN || '').trim()
    if (!token) return { start: false, reason: 'NOVA_EVEN_G2_TOKEN fehlt' }
    if (token.length < MIN_TOKEN_LENGTH) return { start: false, reason: `NOVA_EVEN_G2_TOKEN zu kurz (mindestens ${MIN_TOKEN_LENGTH} Zeichen)` }
    const port = raw.port === undefined ? EVEN_G2_DEFAULT_PORT : Number(raw.port)
    if (!Number.isInteger(port) || port < 0 || port > 65_535) return { start: false, reason: 'channels.evenG2.port ungültig' }
    const allowOrigins = Array.isArray(raw.allowOrigins) ? raw.allowOrigins.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 10) : []
    return { start: true, reason: `an, 127.0.0.1:${port}`, settings: { port, allowOrigins }, token }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/** Constant-time comparison (both sides hashed first, so length differences do not leak). */
export function tokenMatches(provided: string, expected: string): boolean {
    const given = String(provided ?? '').trim()
    const wanted = String(expected ?? '')
    if (!given || !wanted) return false
    return timingSafeEqual(digest(given), digest(wanted))
}

function bearer(req: IncomingMessage): string {
    const header = String(req.headers.authorization || '').trim()
    return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : ''
}

const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D|\p{Emoji_Modifier})*/gu

/** Plain text for the HUD: no Markdown, no emoji, at most `max` characters, cut at a sentence boundary. */
export function formatForG2(raw: unknown, max = MAX_REPLY_CHARS): string {
    let text = String(raw ?? '').replace(/\r\n?/g, '\n')
    text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, '$1')
    text = text.replace(/`([^`\n]*)`/g, '$1')
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    text = text.replace(/<\/?[a-z][^>\n]*>/gi, '')
    text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    text = text.replace(/^[ \t]*>[ \t]?/gm, '')
    text = text.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, '')
    text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, inner: string) => inner.split('|').map(cell => cell.trim()).join(' · '))
    text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    text = text.replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}])/gu, '$1$2')
    text = text.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, '$1$2')
    text = text.replace(/\*\*|__|~~|`/g, '')
    text = text.replace(EMOJI, '')
    text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) return 'Keine Antwort.'
    if (text.length <= max) return text
    const limit = max - 1
    const window = text.slice(0, limit + 1)
    let cut = -1
    const sentence = /[.!?…](?=\s)/g
    for (let match = sentence.exec(window); match; match = sentence.exec(window)) {
        if (match.index + 1 <= limit && match.index + 1 >= Math.floor(max * 0.5)) cut = match.index + 1
    }
    if (cut > 0) return text.slice(0, cut).trim()
    const space = window.lastIndexOf(' ', limit)
    const end = space >= Math.floor(max * 0.5) ? space : limit
    return `${text.slice(0, end).trimEnd()}…`
}

/** Last user message text (string or OpenAI content parts). */
export function extractQuestion(body: any): string {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (!message || typeof message !== 'object' || (message.role && message.role !== 'user')) continue
        const content = message.content
        if (typeof content === 'string') return content.trim().slice(0, MAX_QUESTION_CHARS)
        if (Array.isArray(content)) {
            return content.map((part: any) => (part && typeof part.text === 'string' ? part.text : '')).join(' ').trim().slice(0, MAX_QUESTION_CHARS)
        }
        return ''
    }
    return ''
}

const normalizeQuestion = (question: string) => question.toLocaleLowerCase('de').replace(/\s+/g, ' ').trim()
const short = (value: unknown, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function completion(model: unknown, content: string): Record<string, unknown> {
    return {
        id: `chatcmpl-${createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: typeof model === 'string' && model.length <= 64 ? model : 'xaventra',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }
}

// ---------------------------------------------------------------------------
// voice
// ---------------------------------------------------------------------------

export class VoiceInputError extends Error {
    constructor(readonly status: number, message: string) { super(message) }
}

function wavFromPcm(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(VOICE_SAMPLE_RATE, 24); header.writeUInt32LE(VOICE_BYTES_PER_SECOND, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
}

const isWav = (buffer: Buffer) => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE'

/** Only 16 kHz / 16 bit / mono PCM is accepted; returns the PCM payload. */
function pcmFromWav(buffer: Buffer): Buffer {
    if (buffer.length < 44 || !isWav(buffer)) throw new VoiceInputError(400, 'Kein gültiges WAV.')
    let offset = 12
    let formatOk = false
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const body = offset + 8
        if (id === 'fmt ') {
            if (size < 16 || body + 16 > buffer.length) throw new VoiceInputError(400, 'Kein gültiges WAV.')
            const format = buffer.readUInt16LE(body)
            const channels = buffer.readUInt16LE(body + 2)
            const rate = buffer.readUInt32LE(body + 4)
            const bits = buffer.readUInt16LE(body + 14)
            if (format !== 1 || channels !== 1 || rate !== VOICE_SAMPLE_RATE || bits !== 16) throw new VoiceInputError(400, 'WAV muss 16 kHz, 16 Bit, mono (PCM) sein.')
            formatOk = true
        } else if (id === 'data') {
            if (!formatOk) throw new VoiceInputError(400, 'Kein gültiges WAV.')
            // streamed WAVs may declare 0 or a too large size: take what arrived
            const end = size === 0 || body + size > buffer.length ? buffer.length : body + size
            return buffer.subarray(body, end)
        }
        offset = body + size + (size % 2)
    }
    throw new VoiceInputError(400, 'WAV ohne Audiodaten.')
}

/** Validates the request body and returns PCM16 plus its length in seconds. Throws VoiceInputError (400/413/415). */
export function parseVoiceAudio(body: Buffer, contentTypeHeader: string): { pcm: Buffer; durationSec: number } {
    const [type, ...params] = String(contentTypeHeader || '').split(';').map(part => part.trim())
    const mime = (type || '').toLowerCase()
    let pcm: Buffer
    if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime)) {
        pcm = pcmFromWav(body)
    } else if (mime === 'application/octet-stream' || mime === 'audio/l16') {
        const options = new Map(params.map(param => { const [key, ...value] = param.split('='); return [key.trim().toLowerCase(), value.join('=').trim()] as const }))
        const rate = options.get('rate'), channels = options.get('channels')
        if ((rate && Number(rate) !== VOICE_SAMPLE_RATE) || (channels && Number(channels) !== 1)) throw new VoiceInputError(400, 'Audio muss 16 kHz, 16 Bit, mono sein.')
        // a WAV sent as raw bytes is still a WAV (checked), never PCM noise
        pcm = isWav(body) ? pcmFromWav(body) : body
    } else {
        throw new VoiceInputError(415, 'Content-Type muss audio/wav, audio/L16 oder application/octet-stream sein.')
    }
    if (pcm.length % 2 !== 0) pcm = pcm.subarray(0, pcm.length - 1)
    if (pcm.length < VOICE_MIN_BYTES) throw new VoiceInputError(400, 'Aufnahme zu kurz oder leer.')
    if (pcm.length > VOICE_MAX_SECONDS * VOICE_BYTES_PER_SECOND) throw new VoiceInputError(413, `Aufnahme zu lang (höchstens ${VOICE_MAX_SECONDS} Sekunden).`)
    return { pcm, durationSec: pcm.length / VOICE_BYTES_PER_SECOND }
}

const YES_WORDS = new Set(['ja', 'jo', 'jawohl', 'yes', 'yep', 'yeah', 'okay', 'ok', 'genehmigt', 'genehmige', 'genehmigen', 'mach', 'machs', 'freigeben', 'freigabe', 'freigegeben', 'einverstanden'])
const NO_WORDS = new Set(['nein', 'no', 'nee', 'nö', 'noe', 'nope', 'stopp', 'stop', 'ablehnen', 'abbrechen', 'abgelehnt', 'nicht', 'kein', 'keine', 'niemals', 'nie'])
const NEUTRAL_WORDS = new Set(['bitte', 'doch', 'gerne', 'gern', 'mal', 'es', 'das'])
const MAX_DECISION_TOKENS = 3

const speechTokens = (transcript: string): string[] =>
    String(transcript ?? '').toLocaleLowerCase('de').replace(/ß/g, 'ss').replace(/\blehne\s+ab\b/g, 'ablehnen')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

/**
 * Strict yes/no recognizer for spoken card answers. Only very short utterances
 * made of yes-words (or only no-words) count; mixed, unknown or longer
 * speech yields null so nothing is answered by accident.
 */
export function recognizeYesNo(transcript: string): 'ja' | 'nein' | null {
    const tokens = speechTokens(transcript)
    if (!tokens.length || tokens.length > MAX_DECISION_TOKENS) return null
    let yes = false, no = false
    for (const token of tokens) {
        if (YES_WORDS.has(token)) yes = true
        else if (NO_WORDS.has(token)) no = true
        else if (!NEUTRAL_WORDS.has(token)) return null
    }
    if (yes === no) return null
    return yes ? 'ja' : 'nein'
}

/** A real sentence or question (not a stray word): goes to the agent even while a card is open. */
export function looksLikeSentence(transcript: string): boolean {
    return speechTokens(transcript).length > MAX_DECISION_TOKENS || /\?/.test(String(transcript ?? ''))
}

// ---------------------------------------------------------------------------
// HUD feed
// ---------------------------------------------------------------------------

/** Short card texts for the 576×288 HUD; tokens never leave the server. */
export function buildHudSnapshot(input: { status: string; openCards: ApprovalCard[]; now?: number }): HudSnapshot {
    const cards: HudCard[] = input.openCards.filter(card => card.status === 'offen').slice(-5).map(card => ({
        id: card.id,
        titel: formatForG2(card.titel, 80),
        text: formatForG2(card.vorschlag || card.beleg || card.titel, 160),
        wirkung: card.wirkung,
        antworten: ['ja', 'nein'],
        gueltigBis: card.expiresAt,
    }))
    const status = formatForG2(input.status || 'Bereit', 120)
    const version = createHash('sha1').update(JSON.stringify({ status, cards: cards.map(card => [card.id, card.titel, card.text]) })).digest('hex').slice(0, 16)
    return { version, status, cards, at: new Date(input.now ?? Date.now()).toISOString() }
}

/** Tap = Ja, double tap = Nein. Goes through answerApprovalCard (owner check, single use, Nie-Liste). */
export async function answerCardFromG2(cardId: string, answer: 'ja' | 'nein', opts: CardStoreOptions & { ownerIds: readonly string[] }): Promise<CardAnswerHttp> {
    if (answer !== 'ja' && answer !== 'nein') return { status: 400, body: { ok: false, error: 'Nur ja oder nein.' } }
    if (!/^k[a-f0-9]{12}$/.test(String(cardId ?? ''))) return { status: 404, body: { ok: false, error: 'Unbekannte Karte.' } }
    const ownerIds = (opts.ownerIds || []).map(item => String(item).trim()).filter(item => /^\d{1,20}$/.test(item))
    if (!ownerIds.length) return { status: 403, body: { ok: false, error: 'Kein Owner konfiguriert (channels.telegram.allowFrom).' } }
    const card = listApprovalCards(opts).find(item => item.id === cardId)
    if (!card) return { status: 404, body: { ok: false, error: 'Unbekannte Karte.' } }
    const button = card.status === 'offen' ? card.buttons.find(item => item.answer === answer) : undefined
    if (!button) return { status: 409, body: { ok: false, error: 'Karte wurde bereits beantwortet.', status_karte: card.status } }
    const result = await answerApprovalCard(`ac:${button.token}`, { userId: ownerIds[0], ownerIds, via: EVEN_G2_CHANNEL }, opts)
    const status = result.ok ? 200
        : result.code === 'verbraucht' ? 409
        : result.code === 'abgelaufen' ? 410
        : result.code === 'unbekannt' ? 404
        : result.code === 'kein-owner' || result.code === 'nie-liste' || result.code === 'nicht-erlaubt' ? 403
        : 500
    return { status, body: { ok: result.ok, code: result.code, message: formatForG2(result.message, 200), cardStatus: result.card?.status } }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

interface Inflight { at: number; result: Promise<string>; settled: boolean }

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) { reject(new BodyTooLarge()); req.resume(); return }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function readBodyBuffer(req: IncomingMessage, max: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let size = 0
        let failed = false
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
            if (failed) return
            size += chunk.length
            if (size > max) { failed = true; reject(new BodyTooLarge()); req.resume(); return }
            chunks.push(chunk)
        })
        req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
        req.on('error', reject)
    })
}

export function createEvenG2Handler(deps: EvenG2Deps): (req: IncomingMessage, res: ServerResponse) => void {
    const now = deps.now || Date.now
    const budgetMs = Math.max(10, Math.min(deps.budgetMs ?? DEFAULT_BUDGET_MS, 25_000))
    const dedupeMs = deps.dedupeMs ?? DEFAULT_DEDUPE_MS
    const maxRunMs = deps.maxRunMs ?? DEFAULT_MAX_RUN_MS
    const pollIntervalMs = Math.max(10, deps.pollIntervalMs ?? 1_000)
    const allowOrigins = deps.allowOrigins || []
    const inflight = new Map<string, Inflight>()

    const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
        if (res.writableEnded) return
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
        res.end(JSON.stringify(body))
    }
    const cors = (req: IncomingMessage): Record<string, string> => {
        const origin = String(req.headers.origin || '')
        const allowed = allowOrigins.length === 0 ? '*' : allowOrigins.includes(origin) ? origin : ''
        if (!allowed) return {}
        return {
            'Access-Control-Allow-Origin': allowed,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
            ...(allowed === '*' ? {} : { Vary: 'Origin' }),
        }
    }
    const fenced = async (res: ServerResponse, effect: string, extra: Record<string, string> = {}): Promise<boolean> => {
        try {
            await deps.fence(effect)
            return false
        } catch {
            json(res, 503, { error: 'Nicht der aktive Main-Knoten.' }, extra)
            return true
        }
    }

    /** One pipeline run per question within the dedupe window; budget → interim reply, result → overflow (once). */
    const run = (question: string): Inflight => {
        const at = now()
        for (const [key, entry] of inflight) if (at - entry.at > dedupeMs && entry.settled) inflight.delete(key)
        const key = normalizeQuestion(question)
        const existing = inflight.get(key)
        if (existing && at - existing.at <= dedupeMs) return existing
        const controller = new AbortController()
        const hardStop = setTimeout(() => controller.abort(), maxRunMs)
        hardStop.unref?.()
        let overflowed = false
        const entry: Inflight = { at, settled: false, result: Promise.resolve('') }
        const pipeline = deps.ask(question, controller.signal).then(
            reply => String(reply ?? ''),
            error => {
                console.warn(`[EvenG2] Pipeline-Fehler: ${short((error as Error)?.message || error)}`)
                return 'Das hat leider nicht geklappt. Details stehen im Protokoll.'
            },
        )
        let budgetTimer: ReturnType<typeof setTimeout> | undefined
        const budget = new Promise<string>(resolve => {
            budgetTimer = setTimeout(() => { overflowed = true; resolve(INTERIM_REPLY) }, budgetMs)
            budgetTimer.unref?.()
        })
        void pipeline.then(reply => {
            clearTimeout(hardStop)
            if (budgetTimer) clearTimeout(budgetTimer)
            entry.settled = true
            if (overflowed) {
                deps.overflow(question, reply).catch(error => console.warn(`[EvenG2] Telegram-Nachlieferung fehlgeschlagen: ${short((error as Error)?.message || error)}`))
            }
        })
        entry.result = Promise.race([pipeline, budget])
        inflight.set(key, entry)
        return entry
    }

    const handleAsk = async (req: IncomingMessage, res: ServerResponse) => {
        let raw: string
        try { raw = await readBody(req) } catch (error) {
            json(res, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? 'Anfrage zu groß.' : 'Anfrage unlesbar.' })
            return
        }
        let body: any
        try { body = JSON.parse(raw) } catch { json(res, 400, { error: 'Ungültiges JSON.' }); return }
        if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) { json(res, 400, { error: 'messages[] fehlt.' }); return }
        const question = extractQuestion(body)
        if (!question) { json(res, 400, { error: 'Leere Frage.' }); return }
        if (await fenced(res, 'even-g2:ask')) return
        const reply = await run(question).result
        json(res, 200, completion(body.model, formatForG2(reply)))
    }

    const handleHud = async (req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>) => {
        const since = url.searchParams.get('since') || ''
        const wait = Math.min(MAX_LONG_POLL_MS, Math.max(0, Number(url.searchParams.get('wait') || 0) * 1000 || 0))
        const deadline = Date.now() + wait
        let closed = false
        res.on('close', () => { closed = true })
        let snapshot = await deps.hudSnapshot()
        while (since && snapshot.version === since && Date.now() < deadline && !closed) {
            await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))))
            snapshot = await deps.hudSnapshot()
        }
        if (!closed) json(res, 200, snapshot, headers)
    }

    const handleAnswer = async (req: IncomingMessage, res: ServerResponse, headers: Record<string, string>) => {
        let body: any
        try { body = JSON.parse(await readBody(req)) } catch { json(res, 400, { error: 'Ungültiges JSON.' }, headers); return }
        const answer = body?.answer
        if (answer !== 'ja' && answer !== 'nein') { json(res, 400, { error: 'Nur ja oder nein.' }, headers); return }
        if (await fenced(res, 'even-g2:card-answer', headers)) return
        const result = await deps.answerCard(String(body?.cardId ?? ''), answer)
        json(res, result.status, result.body, headers)
    }

    const handleVoice = async (req: IncomingMessage, res: ServerResponse, url: URL, headers: Record<string, string>) => {
        const transcribe = deps.transcribe
        if (!transcribe) { req.resume(); json(res, 503, { error: 'Spracherkennung nicht verfügbar.' }, headers); return }
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > VOICE_MAX_BODY_BYTES) { req.resume(); json(res, 413, { error: 'Aufnahme zu groß.' }, headers); return }
        let audio: { pcm: Buffer; durationSec: number }
        try {
            audio = parseVoiceAudio(await readBodyBuffer(req, VOICE_MAX_BODY_BYTES), String(req.headers['content-type'] || ''))
        } catch (error) {
            if (error instanceof BodyTooLarge) json(res, 413, { error: 'Aufnahme zu groß.' }, headers)
            else if (error instanceof VoiceInputError) json(res, error.status, { error: error.message }, headers)
            else json(res, 400, { error: 'Anfrage unlesbar.' }, headers)
            return
        }
        if (await fenced(res, 'even-g2:voice', headers)) return

        // STT with a hard time limit; the audio is neither logged nor stored here.
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let transcript = ''
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('stt-timeout')) }, Math.max(10, deps.sttTimeoutMs ?? DEFAULT_STT_TIMEOUT_MS))
                timer.unref?.()
            })
            const heard = transcribe(wavFromPcm(audio.pcm), { durationSec: audio.durationSec, signal: controller.signal })
            heard.catch(() => undefined)
            transcript = String(await Promise.race([heard, timeout]) ?? '').replace(/\s+/g, ' ').trim()
        } catch (error) {
            if ((error as Error)?.message === 'stt-timeout') {
                console.warn('[EvenG2] Spracherkennung: Zeitlimit')
                json(res, 504, { error: 'Spracherkennung hat zu lange gebraucht.' }, headers)
            } else {
                console.warn(`[EvenG2] Spracherkennung nicht verfügbar: ${error instanceof EvenG2SttUnavailableError ? 'kein Dienst' : short((error as Error)?.message || error, 80)}`)
                json(res, 503, { error: 'Spracherkennung nicht verfügbar.' }, headers)
            }
            return
        } finally {
            if (timer) clearTimeout(timer)
        }
        transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS)
        const reply = (status: number, action: VoiceAction, extra: { cardId?: string; reply?: string } = {}) => {
            const body: Record<string, unknown> = { transcript, action }
            if (extra.cardId) body.cardId = extra.cardId
            if (extra.reply) body.reply = formatForG2(extra.reply)
            json(res, status, body, headers)
        }
        if (!transcript) { reply(200, 'none'); return }

        // pending card: the one the HUD shows (optional ?cardId=), else the first open one
        const wanted = url.searchParams.get('cardId') || ''
        const open = (await deps.hudSnapshot()).cards
        const card = wanted ? open.find(item => item.id === wanted) : open[0]
        if (card) {
            const decision = recognizeYesNo(transcript)
            if (decision === 'ja') {
                // outward / physical / infrastructure effects: the HUD asks for an explicit tap
                if (card.wirkung !== 'intern') { reply(200, 'needs_confirm', { cardId: card.id }); return }
                const result = await deps.answerCard(card.id, 'ja')
                const message = typeof result.body.message === 'string' ? result.body.message : ''
                reply(result.status, result.status === 200 ? 'answered_ja' : 'none', { cardId: card.id, reply: message })
                return
            }
            if (decision === 'nein') {
                const result = await deps.answerCard(card.id, 'nein')
                const message = typeof result.body.message === 'string' ? result.body.message : ''
                reply(result.status, result.status === 200 ? 'answered_nein' : 'none', { cardId: card.id, reply: message })
                return
            }
            if (!looksLikeSentence(transcript)) { reply(200, 'none', { cardId: card.id }); return }
        } else if (wanted && !looksLikeSentence(transcript)) {
            // the displayed card is gone (answered elsewhere / expired): a stray word never becomes a command
            reply(200, 'none'); return
        }

        // no card (or a real sentence): new user message, exactly like POST /
        const answer = await run(transcript.slice(0, MAX_QUESTION_CHARS)).result
        reply(200, 'message', { reply: answer })
    }

    return (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const path = url.pathname.replace(/\/+$/, '') || '/'
        const method = req.method || 'GET'
        const isHud = path === '/hud' || path === '/hud/answer' || path === '/hud/voice'
        const headers = isHud ? cors(req) : {}
        void (async () => {
            if (method === 'GET' && path === '/health') { json(res, 200, { ok: true }); return }
            if (isHud && method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
            if (!tokenMatches(bearer(req), deps.token)) {
                console.warn(`[EvenG2] 401 ${method} ${path}`)
                req.resume()
                json(res, 401, { error: 'unauthorized' }, headers)
                return
            }
            if (method === 'POST' && (path === '/' || path === '/v1/chat/completions')) { await handleAsk(req, res); return }
            if (method === 'GET' && path === '/hud') { await handleHud(req, res, url, headers); return }
            if (method === 'POST' && path === '/hud/answer') { await handleAnswer(req, res, headers); return }
            if (method === 'POST' && path === '/hud/voice') { await handleVoice(req, res, url, headers); return }
            req.resume()
            json(res, 404, { error: 'Not found' }, headers)
        })().catch(error => {
            console.warn(`[EvenG2] Fehler: ${short((error as Error)?.message || error)}`)
            json(res, 500, { error: 'Interner Fehler.' }, headers)
        })
    }
}

/** Always 127.0.0.1 — there is deliberately no host parameter. */
export function startEvenG2Server(settings: { port: number; allowOrigins?: string[] }, deps: EvenG2Deps): Promise<EvenG2Server> {
    const server = createServer(createEvenG2Handler({ ...deps, allowOrigins: deps.allowOrigins ?? settings.allowOrigins }))
    server.requestTimeout = 60_000
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(settings.port, EVEN_G2_HOST, () => {
            server.off('error', reject)
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : settings.port
            resolve({
                server,
                port,
                close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()) }),
            })
        })
    })
}

/** Gate + start. Returns null when off, on a worker or without token (the deps factory is not even called). */
export async function startEvenG2Channel(config: any, env: NodeJS.ProcessEnv, makeDeps: (token: string) => EvenG2Deps): Promise<EvenG2Server | null> {
    const resolution = resolveEvenG2Settings(config, env)
    if (!resolution.start || !resolution.settings || !resolution.token) {
        console.log(`[EvenG2] nicht gestartet: ${resolution.reason}`)
        return null
    }
    const server = await startEvenG2Server(resolution.settings, makeDeps(resolution.token))
    console.log(`[EvenG2] ✅ aktiv auf http://${EVEN_G2_HOST}:${server.port} (nur Loopback; HTTPS über tailscale serve)`)
    return server
}
