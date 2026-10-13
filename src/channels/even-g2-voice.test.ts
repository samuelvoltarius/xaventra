import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EvenG2SttUnavailableError, VOICE_MAX_BODY_BYTES, answerCardFromG2, buildHudSnapshot, looksLikeSentence, parseVoiceAudio,
    recognizeYesNo, startEvenG2Server, type EvenG2Deps, type EvenG2Server,
} from './even-g2.js'
import { createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'

// Test values only: generated at runtime, never a real secret.
const TOKEN = `g2-test-${'x'.repeat(32)}`
const OWNER = '100200300'

let dataDir = ''
let servers: EvenG2Server[] = []

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'even-g2-voice-')) })
afterEach(async () => {
    for (const server of servers) await server.close()
    servers = []
    unregisterCardExecutor('g2-test')
    unregisterCardExecutor('drucken-test')
    vi.restoreAllMocks()
    rmSync(dataDir, { recursive: true, force: true })
})

/** 16 kHz / 16 bit / mono PCM of `seconds` (a quiet tone; content is irrelevant, STT is mocked). */
function pcm(seconds: number): Buffer {
    const out = Buffer.alloc(Math.round(seconds * 32_000))
    for (let i = 0; i < out.length / 2; i++) out.writeInt16LE(Math.round(Math.sin(i / 20) * 2_000), i * 2)
    return out
}

function wav(data: Buffer, { rate = 16_000, channels = 1, bits = 16, format = 1 } = {}): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(format, 20); header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * (bits / 8), 28); header.writeUInt16LE(channels * (bits / 8), 32); header.writeUInt16LE(bits, 34)
    header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
}

function card(art = 'g2-test', kind = 'g2-test') {
    const result = createApprovalCard({ art, titel: 'Modell wechseln?', beleg: 'Test', vorschlag: 'Auf Modell B wechseln', aktion: { kind, ref: 'r1' } }, { dataDir })
    if (!result.ok) throw new Error(result.reason)
    return result.card
}

function deps(transcript: string | (() => Promise<string>) = 'ja', overrides: Partial<EvenG2Deps> = {}): EvenG2Deps {
    return {
        token: TOKEN,
        ask: vi.fn(async (question: string) => `Antwort auf ${question}`),
        overflow: vi.fn(async () => undefined),
        fence: vi.fn(async () => undefined),
        hudSnapshot: async () => buildHudSnapshot({ status: 'Bereit', openCards: listApprovalCards({ dataDir, status: ['offen'] }) }),
        answerCard: vi.fn((cardId, answer) => answerCardFromG2(cardId, answer, { ownerIds: [OWNER], dataDir, ledger: null })),
        transcribe: vi.fn(async () => (typeof transcript === 'function' ? transcript() : transcript)),
        budgetMs: 2_000,
        ...overrides,
    }
}

async function start(d: EvenG2Deps): Promise<string> {
    const server = await startEvenG2Server({ port: 0 }, d)
    servers.push(server)
    return `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
}

const speak = (url: string, body: Buffer, { token = TOKEN as string | null, type = 'application/octet-stream', query = '' } = {}) => fetch(`${url}/hud/voice${query}`, {
    method: 'POST',
    headers: { 'Content-Type': type, ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: new Uint8Array(body),
})

const askText = (url: string, body: unknown, { token = TOKEN as string | null, query = '' } = {}) => fetch(`${url}/hud/ask${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
})

const feed = async (url: string) => {
    const response = await fetch(`${url}/hud`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    return response.json() as Promise<{ version: string; status: string; cards: unknown[]; at: string; reply?: { id: string; text: string; done: boolean } }>
}

/** ask() that hands out its delta callback and a finish function for the test. */
function streamingAsk() {
    let emit: ((text: string) => void) | undefined
    let finish: ((text: string) => void) | undefined
    const ask = vi.fn((_question: string, _signal: AbortSignal, onDelta?: (text: string) => void) => new Promise<string>(resolve => {
        emit = text => onDelta?.(text)
        finish = resolve
    }))
    return {
        ask,
        emit: (text: string) => emit?.(text),
        finish: (text: string) => finish?.(text),
        started: () => Boolean(emit),
    }
}

describe('Even G2 /hud/voice: auth and CORS', () => {
    it('401 without or with a wrong token and the STT is never called', async () => {
        const d = deps()
        const url = await start(d)
        expect((await speak(url, pcm(1), { token: null })).status).toBe(401)
        expect((await speak(url, pcm(1), { token: 'falsch' })).status).toBe(401)
        expect(d.transcribe).not.toHaveBeenCalled()
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('preflight needs no token and allows Authorization and Content-Type', async () => {
        const url = await start(deps())
        const response = await fetch(`${url}/hud/voice`, { method: 'OPTIONS', headers: { Origin: 'https://app.example' } })
        expect(response.status).toBe(204)
        expect(response.headers.get('access-control-allow-headers')).toMatch(/authorization/i)
        expect(response.headers.get('access-control-allow-headers')).toMatch(/content-type/i)
        expect(response.headers.get('access-control-allow-methods')).toMatch(/POST/)
    })

    it('answers carry the CORS headers of the allowed origin only', async () => {
        const d = deps('hallo')
        const server = await startEvenG2Server({ port: 0, allowOrigins: ['https://app.example'] }, d)
        servers.push(server)
        const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
        const send = (origin: string) => fetch(`${url}/hud/voice`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream', Origin: origin }, body: new Uint8Array(pcm(1)) })
        expect((await send('https://app.example')).headers.get('access-control-allow-origin')).toBe('https://app.example')
        expect((await send('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
    })

    it('503 when the Main fence refuses and the STT is not called', async () => {
        const d = deps('ja', { fence: vi.fn(async () => { throw Object.assign(new Error('Fenced'), { code: 'FENCED' }) }) })
        const url = await start(d)
        expect((await speak(url, pcm(1))).status).toBe(503)
        expect(d.transcribe).not.toHaveBeenCalled()
        expect(d.ask).not.toHaveBeenCalled()
    })
})

describe('Even G2 /hud/voice: audio format and limits', () => {
    it('accepts raw PCM (octet-stream and audio/L16) and WAV', async () => {
        const d = deps('guten morgen')
        const url = await start(d)
        for (const [type, body] of [
            ['application/octet-stream', pcm(1)],
            ['audio/L16; rate=16000; channels=1', pcm(1)],
            ['audio/wav', wav(pcm(1))],
            ['audio/x-wav', wav(pcm(1))],
        ] as Array<[string, Buffer]>) {
            const response = await speak(url, body, { type })
            expect(response.status, type).toBe(200)
            expect((await response.json()).transcript).toBe('guten morgen')
        }
        // the STT always receives a 16 kHz mono WAV with the PCM payload
        const [handed, options] = (d.transcribe as any).mock.calls[0]
        expect(handed.toString('ascii', 0, 4)).toBe('RIFF')
        expect(handed.length).toBe(44 + 32_000)
        expect(options.durationSec).toBeCloseTo(1, 5)
    })

    it('rejects other formats', async () => {
        const d = deps()
        const url = await start(d)
        expect((await speak(url, wav(pcm(1), { rate: 44_100 }), { type: 'audio/wav' })).status).toBe(400)
        expect((await speak(url, wav(pcm(1), { channels: 2 }), { type: 'audio/wav' })).status).toBe(400)
        expect((await speak(url, wav(pcm(1), { bits: 8 }), { type: 'audio/wav' })).status).toBe(400)
        expect((await speak(url, wav(pcm(1), { format: 3 }), { type: 'audio/wav' })).status).toBe(400)
        expect((await speak(url, pcm(1), { type: 'audio/wav' })).status).toBe(400)
        expect((await speak(url, pcm(1), { type: 'audio/L16; rate=44100' })).status).toBe(400)
        expect((await speak(url, pcm(1), { type: 'audio/mpeg' })).status).toBe(415)
        expect((await speak(url, pcm(1), { type: 'application/json' })).status).toBe(415)
        expect(d.transcribe).not.toHaveBeenCalled()
    })

    it('rejects empty and too short audio with 400', async () => {
        const d = deps()
        const url = await start(d)
        expect((await speak(url, Buffer.alloc(0))).status).toBe(400)
        expect((await speak(url, pcm(0.1))).status).toBe(400)
        expect((await speak(url, wav(Buffer.alloc(0)), { type: 'audio/wav' })).status).toBe(400)
        expect(d.transcribe).not.toHaveBeenCalled()
    })

    it('rejects too long audio with 413 (over 20 s and over the byte cap)', async () => {
        const d = deps()
        const url = await start(d)
        expect((await speak(url, pcm(20.5))).status).toBe(413)
        expect((await speak(url, wav(pcm(21)), { type: 'audio/wav' })).status).toBe(413)
        expect((await speak(url, Buffer.alloc(VOICE_MAX_BODY_BYTES + 1))).status).toBe(413)
        expect((await speak(url, pcm(20))).status).toBe(200)
        expect(d.transcribe).toHaveBeenCalledTimes(1)
    })

    it('parseVoiceAudio reports duration and drops a dangling byte', () => {
        const parsed = parseVoiceAudio(Buffer.concat([pcm(2), Buffer.from([1])]), 'application/octet-stream')
        expect(parsed.pcm.length).toBe(64_000)
        expect(parsed.durationSec).toBe(2)
    })
})

describe('Even G2 /hud/voice: STT errors', () => {
    it('504 on STT timeout', async () => {
        const d = deps(() => new Promise<string>(() => undefined), { sttTimeoutMs: 60 })
        const url = await start(d)
        const response = await speak(url, pcm(1))
        expect(response.status).toBe(504)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('503 without a configured STT and when it is unavailable, without secrets in the message', async () => {
        const url = await start(deps('ja', { transcribe: undefined }))
        const none = await speak(url, pcm(1))
        expect(none.status).toBe(503)
        const down = deps('x', { transcribe: vi.fn(async () => { throw new EvenG2SttUnavailableError() }) })
        const response = await speak(await start(down), pcm(1))
        expect(response.status).toBe(503)
        const text = JSON.stringify(await response.json())
        expect(text).toMatch(/Spracherkennung/)
        expect(text).not.toContain(TOKEN)
    })

    it('empty transcript: action none and no pipeline run', async () => {
        const d = deps('   ')
        const body = await (await speak(await start(d), pcm(1))).json()
        expect(body).toEqual({ transcript: '', action: 'none' })
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('neither token nor audio nor transcript reach the log', async () => {
        const logs: string[] = []
        for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
        const url = await start(deps('Mein geheimer Satz', { transcribe: vi.fn(async () => { throw new Error('kaputt') }) }))
        await speak(url, pcm(1), { token: 'falsch' })
        await speak(url, pcm(1))
        const timeout = await start(deps(() => new Promise<string>(() => undefined), { sttTimeoutMs: 40 }))
        await speak(timeout, pcm(1))
        const ok = await start(deps('Mein geheimer Satz'))
        await speak(ok, pcm(1))
        const all = logs.join('\n')
        expect(logs.length).toBeGreaterThan(0)
        expect(all).not.toContain(TOKEN)
        expect(all).not.toContain('geheimer Satz')
    })
})

describe('Even G2 /hud/voice: spoken card answers', () => {
    it('ja on an internal card answers it through the same path as /hud/answer', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'erledigt' }))
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute })
        const created = card()
        expect(created.wirkung).toBe('intern')
        const d = deps('Ja, bitte')
        const response = await speak(await start(d), pcm(1))
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toMatchObject({ transcript: 'Ja, bitte', action: 'answered_ja', cardId: created.id })
        expect(body.reply.length).toBeLessThanOrEqual(400)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(d.answerCard).toHaveBeenCalledWith(created.id, 'ja')
        const stored = listApprovalCards({ dataDir }).find(item => item.id === created.id)!
        expect(stored.status).toBe('ja')
        expect(stored.decidedBy).toBe(`even-g2:${OWNER}`)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('nein rejects the card without running it', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'erledigt' }))
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute })
        const created = card()
        const d = deps('nein')
        const body = await (await speak(await start(d), pcm(1))).json()
        expect(body).toMatchObject({ action: 'answered_nein', cardId: created.id })
        expect(execute).not.toHaveBeenCalled()
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('nein')
    })

    it('a physical card: ja only asks for the explicit confirm, answerApprovalCard is never reached', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'gedruckt' }))
        registerCardExecutor({ isStillOpen: () => true, kind: 'drucken-test', impact: 'physisch', execute })
        const created = card('drucken-test', 'drucken-test')
        expect(created.wirkung).toBe('physisch')
        const d = deps('ja')
        const body = await (await speak(await start(d), pcm(1))).json()
        expect(body).toEqual({ transcript: 'ja', action: 'needs_confirm', cardId: created.id })
        expect(d.answerCard).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('offen')
    })

    it('a physical card can still be rejected by voice', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'drucken-test', impact: 'physisch', execute: async () => ({ ok: true, message: 'x' }) })
        const created = card('drucken-test', 'drucken-test')
        const body = await (await speak(await start(deps('stopp')), pcm(1))).json()
        expect(body).toMatchObject({ action: 'answered_nein', cardId: created.id })
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('nein')
    })

    it('ambiguous speech with a card open decides nothing', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute: vi.fn(async () => ({ ok: true, message: 'x' })) })
        const created = card()
        for (const text of ['vielleicht', 'ja nein', 'ja aber', 'hm', 'nicht freigeben']) {
            const d = deps(text)
            const body = await (await speak(await start(d), pcm(1))).json()
            expect(body, text).toMatchObject({ transcript: text, action: 'none', cardId: created.id })
            expect(d.answerCard, text).not.toHaveBeenCalled()
            expect(d.ask, text).not.toHaveBeenCalled()
        }
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('offen')
    })

    it('a real sentence or question with a card open goes to the agent, the card stays open', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute: vi.fn(async () => ({ ok: true, message: 'x' })) })
        const created = card()
        const d = deps('Ja, wie spät ist es denn gerade?')
        const body = await (await speak(await start(d), pcm(2))).json()
        expect(body.action).toBe('message')
        expect(body.reply).toBe('Antwort auf Ja, wie spät ist es denn gerade?')
        expect(d.answerCard).not.toHaveBeenCalled()
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('offen')
    })

    it('?cardId binds the answer to the shown card, an unknown id decides nothing', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute: vi.fn(async () => ({ ok: true, message: 'fertig' })) })
        const first = card()
        const second = createApprovalCard({ art: 'g2-test', titel: 'Zweite Karte', beleg: 'B', vorschlag: 'V', aktion: { kind: 'g2-test', ref: 'r2' } }, { dataDir })
        if (!second.ok) throw new Error(second.reason)
        const d = deps('ja')
        const url = await start(d)
        const body = await (await speak(url, pcm(1), { query: `?cardId=${second.card.id}` })).json()
        expect(body).toMatchObject({ action: 'answered_ja', cardId: second.card.id })
        const gone = await (await speak(url, pcm(1), { query: '?cardId=kdeadbeef0000' })).json()
        expect(gone.action).toBe('none')
        expect(listApprovalCards({ dataDir }).find(item => item.id === first.id)!.status).toBe('offen')
    })

    it('never "immer erlauben" by voice', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', allowAlways: () => true, execute: vi.fn(async () => ({ ok: true, message: 'x' })) })
        const created = card()
        for (const text of ['immer erlauben', 'immer']) {
            const d = deps(text)
            const body = await (await speak(await start(d), pcm(1))).json()
            expect(body.action, text).not.toMatch(/answered/)
            expect(d.answerCard, text).not.toHaveBeenCalledWith(expect.anything(), 'immer')
        }
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('offen')
    })

    it('a card that was answered meanwhile (409) is reported as none', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute: vi.fn(async () => ({ ok: true, message: 'x' })) })
        const created = card()
        const d = deps('ja', { answerCard: vi.fn(async () => ({ status: 409, body: { ok: false, message: 'Schon beantwortet.' } })) })
        const response = await speak(await start(d), pcm(1))
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ action: 'none', cardId: created.id, reply: 'Schon beantwortet.' })
    })
})

describe('Even G2 /hud/voice: free speech', () => {
    it('without a card the transcript becomes a normal user message, answer at most 400 characters', async () => {
        const long = `**Fett** ${'Ein langer Satz. '.repeat(60)}`
        const d = deps('Was steht heute an?', { ask: vi.fn(async () => long) })
        const body = await (await speak(await start(d), pcm(2))).json()
        expect(body.action).toBe('message')
        expect(body.transcript).toBe('Was steht heute an?')
        expect(body.reply.length).toBeLessThanOrEqual(400)
        expect(body.reply).not.toContain('**')
        expect(d.ask).toHaveBeenCalledTimes(1)
        expect((d.ask as any).mock.calls[0][0]).toBe('Was steht heute an?')
    })

    it('a plain yes without any card is just a message, never a card action', async () => {
        const d = deps('ja')
        const body = await (await speak(await start(d), pcm(1))).json()
        expect(body.action).toBe('message')
        expect(d.answerCard).not.toHaveBeenCalled()
    })

    it('the same sentence twice runs the pipeline once (dedupe)', async () => {
        const d = deps('Wie wird das Wetter?')
        const url = await start(d)
        await Promise.all([speak(url, pcm(1)), speak(url, pcm(1))])
        expect(d.ask).toHaveBeenCalledTimes(1)
    })

    it('over the time budget: interim reply and the result goes to overflow', async () => {
        let release: (value: string) => void = () => undefined
        const d = deps('Recherchiere lange', { budgetMs: 80, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) })
        const body = await (await speak(await start(d), pcm(1))).json()
        expect(body.action).toBe('message')
        expect(body.reply).toMatch(/arbeite dran.*Telegram/i)
        release('Das ausführliche Ergebnis.')
        await vi.waitFor(() => expect(d.overflow).toHaveBeenCalledWith('Recherchiere lange', 'Das ausführliche Ergebnis.'))
    })
})

describe('yes/no recognizer', () => {
    it('accepts short German and English decisions only', () => {
        for (const text of ['ja', 'Ja!', 'yes', 'okay', 'OK', 'genehmigt', 'mach', 'mach das', 'freigeben', 'ja bitte', 'Ja, mach.']) expect(recognizeYesNo(text), text).toBe('ja')
        for (const text of ['nein', 'Nein.', 'no', 'stopp', 'ablehnen', 'abbrechen', 'lehne ab']) expect(recognizeYesNo(text), text).toBe('nein')
    })

    it('ambiguous, mixed and longer speech is no decision', () => {
        for (const text of ['', 'vielleicht', 'ja nein', 'nicht freigeben', 'ja ich glaube schon', 'ja ja ja ja', 'okay aber erst morgen', 'Wie spät ist es', 'nein danke']) expect(recognizeYesNo(text), text).toBeNull()
    })

    it('tells sentences from stray words', () => {
        expect(looksLikeSentence('vielleicht')).toBe(false)
        expect(looksLikeSentence('ja nein')).toBe(false)
        expect(looksLikeSentence('wie spät ist es')).toBe(true)
        expect(looksLikeSentence('Wetter?')).toBe(true)
    })
})

describe('Even G2 /hud/ask: auth, CORS and limits', () => {
    it('401 without or with a wrong token and the pipeline never runs', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'nie') })
        const url = await start(d)
        expect((await askText(url, { text: 'Hallo' }, { token: null })).status).toBe(401)
        expect((await askText(url, { text: 'Hallo' }, { token: 'falsch' })).status).toBe(401)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('preflight needs no token and allows Authorization and Content-Type', async () => {
        const url = await start(deps())
        const response = await fetch(`${url}/hud/ask`, { method: 'OPTIONS', headers: { Origin: 'https://app.example' } })
        expect(response.status).toBe(204)
        expect(response.headers.get('access-control-allow-headers')).toMatch(/authorization/i)
        expect(response.headers.get('access-control-allow-headers')).toMatch(/content-type/i)
        expect(response.headers.get('access-control-allow-methods')).toMatch(/POST/)
    })

    it('answers carry the CORS headers of the allowed origin only', async () => {
        const server = await startEvenG2Server({ port: 0, allowOrigins: ['https://app.example'] }, deps('ja', { ask: vi.fn(async () => 'ok') }))
        servers.push(server)
        const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
        const send = (origin: string) => fetch(`${url}/hud/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, Origin: origin },
            body: JSON.stringify({ text: 'Hallo' }),
        })
        expect((await send('https://app.example')).headers.get('access-control-allow-origin')).toBe('https://app.example')
        expect((await send('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
    })

    it('400 for empty and for too long text (over 2000 characters)', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'ok') })
        const url = await start(d)
        for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }, { text: 'x'.repeat(2_001) }]) {
            const response = await askText(url, body)
            expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400)
        }
        const broken = await fetch(`${url}/hud/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{' })
        expect(broken.status).toBe(400)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('2000 characters are accepted', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'ok') })
        const response = await askText(await start(d), { text: 'x'.repeat(2_000) })
        expect(response.status).toBe(200)
        expect((await response.json()).action).toBe('message')
    })

    it('503 when the Main fence refuses and the pipeline does not run', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'nie'), fence: vi.fn(async () => { throw Object.assign(new Error('Fenced'), { code: 'FENCED' }) }) })
        const response = await askText(await start(d), { text: 'Hallo' })
        expect(response.status).toBe(503)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('neither the text nor the token reach the log', async () => {
        const logs: string[] = []
        for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
        const url = await start(deps('ja', { ask: vi.fn(async () => 'irgendeine Antwort') }))
        await askText(url, { text: 'Mein geheimer Satz' }, { token: 'falsch' })
        await askText(url, { text: 'Mein geheimer Satz' })
        const all = logs.join('\n')
        expect(all).not.toContain(TOKEN)
        expect(all).not.toContain('geheimer Satz')
    })
})

describe('Even G2 /hud/ask: the same decision path as /hud/voice', () => {
    it('the text becomes a normal user message, answer at most 400 characters', async () => {
        const long = `**Fett** ${'Ein langer Satz. '.repeat(60)}`
        const d = deps('ja', { ask: vi.fn(async () => long) })
        const body = await (await askText(await start(d), { text: 'Was steht heute an?' })).json()
        expect(body.action).toBe('message')
        expect(body.transcript).toBe('Was steht heute an?')
        expect(body.reply.length).toBeLessThanOrEqual(400)
        expect(body.reply).not.toContain('**')
        expect(d.ask).toHaveBeenCalledTimes(1)
        expect((d.ask as any).mock.calls[0][0]).toBe('Was steht heute an?')
    })

    it('the full text goes to the agent, the echo is at most 500 characters', async () => {
        const long = `${'Ein langer Text. '.repeat(100)}`.trim()
        const d = deps('ja', { ask: vi.fn(async () => 'ok') })
        const body = await (await askText(await start(d), { text: long })).json()
        expect((d.ask as any).mock.calls[0][0]).toBe(long)
        expect(body.transcript).toBe(long.slice(0, 500))
    })

    it('line breaks are collapsed before the pipeline runs', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'ok') })
        const body = await (await askText(await start(d), { text: 'Wie   spät\nist  es?' })).json()
        expect(body.transcript).toBe('Wie spät ist es?')
        expect((d.ask as any).mock.calls[0][0]).toBe('Wie spät ist es?')
    })

    it('ja and nein as text answer the shown card, exactly like speech', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'erledigt' }))
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute })
        const created = card()
        const d = deps('ja', { ask: vi.fn(async () => 'nie') })
        const url = await start(d)
        const body = await (await askText(url, { text: 'Ja, bitte' })).json()
        expect(body).toMatchObject({ transcript: 'Ja, bitte', action: 'answered_ja', cardId: created.id })
        expect(body.reply.length).toBeLessThanOrEqual(400)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(d.answerCard).toHaveBeenCalledWith(created.id, 'ja')
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('ja')
        expect(d.ask).not.toHaveBeenCalled()

        const second = card()
        const rejected = await (await askText(url, { text: 'nein' })).json()
        expect(rejected).toMatchObject({ action: 'answered_nein', cardId: second.id })
        expect(listApprovalCards({ dataDir }).find(item => item.id === second.id)!.status).toBe('nein')
    })

    it('a physical card by text only asks for the explicit tap', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'drucken-test', impact: 'physisch', execute: vi.fn(async () => ({ ok: true, message: 'gedruckt' })) })
        const created = card('drucken-test', 'drucken-test')
        const body = await (await askText(await start(deps('ja')), { text: 'ja' })).json()
        expect(body).toEqual({ transcript: 'ja', action: 'needs_confirm', cardId: created.id })
        expect(listApprovalCards({ dataDir }).find(item => item.id === created.id)!.status).toBe('offen')
    })

    it('body.cardId binds the answer to the shown card, a real sentence goes to the agent', async () => {
        registerCardExecutor({ isStillOpen: () => true, kind: 'g2-test', execute: vi.fn(async () => ({ ok: true, message: 'fertig' })) })
        const first = card()
        const second = createApprovalCard({ art: 'g2-test', titel: 'Zweite Karte', beleg: 'B', vorschlag: 'V', aktion: { kind: 'g2-test', ref: 'r2' } }, { dataDir })
        if (!second.ok) throw new Error(second.reason)
        const d = deps('ja', { ask: vi.fn(async () => 'Antwort') })
        const url = await start(d)
        const bound = await (await askText(url, { text: 'ja', cardId: second.card.id })).json()
        expect(bound).toMatchObject({ action: 'answered_ja', cardId: second.card.id })
        const query = await (await askText(url, { text: 'ja', cardId: second.card.id }, { query: `?cardId=${first.id}` })).json()
        expect(query).toMatchObject({ action: 'answered_ja', cardId: first.id })
        const gone = await (await askText(url, { text: 'vielleicht', cardId: 'kdeadbeef0000' })).json()
        expect(gone.action).toBe('none')
        const sentence = await (await askText(url, { text: 'Wie spät ist es denn gerade?' })).json()
        expect(sentence.action).toBe('message')
        expect(d.ask).toHaveBeenCalledTimes(1)
    })

    it('the same text twice runs the pipeline once (dedupe)', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'A') })
        const url = await start(d)
        await Promise.all([askText(url, { text: 'Wie wird das Wetter?' }), askText(url, { text: 'Wie wird das Wetter?' })])
        expect(d.ask).toHaveBeenCalledTimes(1)
    })
})

describe('Even G2 HUD feed: the running answer', () => {
    it('publishes reply.text as it grows and sets done at the end', async () => {
        const stream = streamingAsk()
        const d = deps('ja', { ask: stream.ask, replyDeltaMs: 0 })
        const url = await start(d)
        const asked = askText(url, { text: 'Was steht an?' })
        await vi.waitFor(() => expect(stream.started()).toBe(true))
        expect((await feed(url)).reply).toMatchObject({ text: '', done: false })
        stream.emit('Dein')
        await vi.waitFor(async () => expect((await feed(url)).reply).toMatchObject({ text: 'Dein', done: false }))
        stream.emit('Dein Termin um 14 Uhr.')
        const during = await feed(url)
        expect(during.reply).toMatchObject({ text: 'Dein Termin um 14 Uhr.', done: false })
        stream.finish('Dein Termin um 14 Uhr.')
        const body = await (await asked).json()
        expect(body).toMatchObject({ transcript: 'Was steht an?', action: 'message', reply: 'Dein Termin um 14 Uhr.' })
        const done = await feed(url)
        expect(done.reply).toMatchObject({ text: 'Dein Termin um 14 Uhr.', done: true })
        expect(done.reply!.id).toBe(during.reply!.id)
    })

    it('every published delta changes the long-poll version', async () => {
        const stream = streamingAsk()
        const d = deps('ja', { ask: stream.ask, replyDeltaMs: 0 })
        const url = await start(d)
        const asked = askText(url, { text: 'Zähle' })
        await vi.waitFor(() => expect(stream.started()).toBe(true))
        const before = (await feed(url)).version
        stream.emit('Eins')
        const afterOne = await feed(url)
        expect(afterOne.version).not.toBe(before)
        stream.emit('Eins zwei')
        const afterTwo = await feed(url)
        expect(afterTwo.version).not.toBe(afterOne.version)
        stream.finish('Eins zwei')
        await asked
        expect((await feed(url)).version).not.toBe(afterTwo.version)
    })

    it('deltas are throttled to one new reply.text per 250 ms', async () => {
        const stream = streamingAsk()
        let clock = 1_000_000
        const d = deps('ja', { ask: stream.ask, now: () => clock })
        const url = await start(d)
        const asked = askText(url, { text: 'Langsamer Strom' })
        await vi.waitFor(() => expect(stream.started()).toBe(true))
        stream.emit('Eins')
        const first = await feed(url)
        expect(first.reply).toMatchObject({ text: 'Eins', done: false })
        stream.emit('Eins zwei')
        const held = await feed(url)
        expect(held.reply!.text).toBe('Eins')
        expect(held.version).toBe(first.version)
        clock += 300
        stream.emit('Eins zwei drei')
        const released = await feed(url)
        expect(released.reply!.text).toBe('Eins zwei drei')
        expect(released.version).not.toBe(first.version)
        stream.finish('Eins zwei drei')
        await asked
        expect((await feed(url)).reply).toMatchObject({ text: 'Eins zwei drei', done: true })
    })

    it('over the time budget: interim reply in the POST, the result in the feed and once in Telegram', async () => {
        let release: (value: string) => void = () => undefined
        const d = deps('ja', {
            budgetMs: 80,
            replyDeltaMs: 0,
            ask: vi.fn((_q: string, _s: AbortSignal, onDelta?: (text: string) => void) => new Promise<string>(resolve => {
                onDelta?.('Das ausführliche Ergebnis.')
                release = resolve
            })),
        })
        const url = await start(d)
        const body = await (await askText(url, { text: 'Recherchiere lange' })).json()
        expect(body.action).toBe('message')
        expect(body.reply).toMatch(/arbeite dran.*Telegram/i)
        expect((await feed(url)).reply).toMatchObject({ text: 'Das ausführliche Ergebnis.', done: false })
        release('Das ausführliche Ergebnis.')
        await vi.waitFor(async () => expect((await feed(url)).reply).toMatchObject({ text: 'Das ausführliche Ergebnis.', done: true }))
        await vi.waitFor(() => expect(d.overflow).toHaveBeenCalledWith('Recherchiere lange', 'Das ausführliche Ergebnis.'))
    })

    it('the feed carries no question, no transcript field and no token', async () => {
        const d = deps('ja', { ask: vi.fn(async () => 'Nur die Antwort.'), replyDeltaMs: 0 })
        const url = await start(d)
        await askText(url, { text: 'Mein geheimer Satz' })
        const snapshot = await feed(url)
        const text = JSON.stringify(snapshot)
        expect(snapshot.reply).toMatchObject({ text: 'Nur die Antwort.', done: true })
        expect(text).not.toContain('geheimer Satz')
        expect(text).not.toContain(TOKEN)
        expect(snapshot).not.toHaveProperty('transcript')
    })

    it('the reply field goes away again after the round is done and out of the window', async () => {
        let clock = 1_000_000
        const stream = streamingAsk()
        const d = deps('ja', { ask: stream.ask, now: () => clock, dedupeMs: 500, replyDeltaMs: 0 })
        const url = await start(d)
        const asked = askText(url, { text: 'Kurze Frage' })
        await vi.waitFor(() => expect(stream.started()).toBe(true))
        stream.finish('Kurze Antwort')
        await asked
        expect((await feed(url)).reply).toMatchObject({ text: 'Kurze Antwort', done: true })
        clock += 400
        expect((await feed(url)).reply).toMatchObject({ done: true })
        clock += 200
        expect((await feed(url)).reply).toBeUndefined()
        expect((await feed(url)).status).toBe('Bereit')
    })
})
