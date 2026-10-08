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
