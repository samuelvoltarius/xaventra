import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeVoiceTicket, issueVoiceTicket, registerVoiceApi, runVoiceCallBridge, voiceStatus } from './voice-api.js'

// 2.86 Paket O: „Anrufen“ in der App. Der Main verbindet Browser ⇄ Sprachdienst
// (VAD, Partials, Endtext) und holt die Antwort aus der Pipeline. Kein Netz im Test.

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'voice-api-')); process.env.NOVA_RUNTIME_ROOT = root })
afterEach(() => { delete process.env.NOVA_RUNTIME_ROOT; rmSync(root, { recursive: true, force: true }) })

describe('Einmal-Ticket für den Anruf', () => {
    it('gilt genau einmal und nur kurz', () => {
        let now = 1_000
        const ticket = issueVoiceTicket({ principalId: 'desktop-owner', clientId: 'web-1' }, () => now)
        expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(consumeVoiceTicket(ticket, () => now)).toMatchObject({ principalId: 'desktop-owner' })
        expect(consumeVoiceTicket(ticket, () => now)).toBeNull()
        const late = issueVoiceTicket({ principalId: 'desktop-owner', clientId: 'web-1' }, () => now)
        now += 61_000
        expect(consumeVoiceTicket(late, () => now)).toBeNull()
        expect(consumeVoiceTicket('erfunden', () => now)).toBeNull()
    })
})

async function call(app: express.Express, method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const port = (server.address() as any).port
    try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, data: await response.json() }
    } finally { server.close() }
}

function appWith(owner: boolean, discover = async () => null as any) {
    const app = express()
    app.use(express.json())
    registerVoiceApi(app, { isOwner: () => owner, principal: () => 'desktop-owner', clientId: () => 'web-1', discover })
    return app
}

describe('/api/desktop/sprache', () => {
    it('Status ohne Sprachdienst: ehrlich + Knopf zum Werkzeugkasten-Eintrag', async () => {
        const { status, data } = await call(appWith(true), 'GET', '/api/desktop/sprache')
        expect(status).toBe(200)
        expect(data).toMatchObject({ dienst: { gefunden: false }, einstellung: { replyByVoice: false, voice: 'female' }, knopf: { katalogId: 'sprachdienst:de' } })
        expect(data.text).toMatch(/Sprachdienst/)
    })
    it('Status mit Sprachdienst: wo er läuft, ohne Technik-Adresse im Text', async () => {
        const { data } = await call(appWith(true, async () => ({ endpoint: 'http://100.64.0.12:18795', sourceNode: 'ns1', host: '100.64.0.12' })), 'GET', '/api/desktop/sprache')
        expect(data.dienst).toEqual({ gefunden: true, knoten: 'ns1' })
        expect(data.knopf).toBeUndefined()
        expect(JSON.stringify(data)).not.toContain('100.64.0.12')
    })
    it('Einstellung „Antworten auch als Sprache“ und Stimme: nur der Owner', async () => {
        expect((await call(appWith(false), 'PATCH', '/api/desktop/sprache', { replyByVoice: true })).status).toBe(403)
        const { status, data } = await call(appWith(true), 'PATCH', '/api/desktop/sprache', { replyByVoice: true, voice: 'male' })
        expect(status).toBe(200)
        expect(data.einstellung).toEqual({ replyByVoice: true, voice: 'male' })
    })
    it('Anruf-Ticket nur für den Owner', async () => {
        expect((await call(appWith(false), 'POST', '/api/desktop/sprache/anruf')).status).toBe(403)
        const { status, data } = await call(appWith(true), 'POST', '/api/desktop/sprache/anruf')
        expect(status).toBe(200)
        expect(data.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(data.pfad).toBe('/api/desktop/sprache/anruf/ws')
    })
})

class FakeSocket extends EventEmitter {
    sent: any[] = []
    closed = false
    readyState = 1
    OPEN = 1
    send(data: any) { this.sent.push(data) }
    close() { this.closed = true; this.emit('close') }
}

describe('Anruf-Brücke Browser ⇄ Sprachdienst ⇄ Pipeline', () => {
    it('ohne Sprachdienst: ein Satz, Knopf-Hinweis, Verbindung zu', async () => {
        const browser = new FakeSocket()
        await runVoiceCallBridge(browser as any, { discover: async () => null, openUpstream: vi.fn() as any, answer: vi.fn(), voice: 'female' })
        const notice = JSON.parse(browser.sent[0])
        expect(notice).toMatchObject({ type: 'notice', setup: true })
        expect(browser.closed).toBe(true)
    })

    it('leitet Mikrofon-Rahmen weiter, beantwortet den Endtext über die Pipeline und spricht die Antwort', async () => {
        const browser = new FakeSocket()
        const upstream = new FakeSocket()
        const answer = vi.fn(async (text: string) => `Du hast gesagt: ${text}.`)
        const speak = vi.fn(async (text: string) => ({ audio: Buffer.from(text), mime: 'audio/wav', durationSec: 0.5 }))
        await runVoiceCallBridge(browser as any, {
            discover: async () => ({ endpoint: 'http://127.0.0.1:18795' } as any),
            openUpstream: () => upstream as any, answer, voice: 'female', speak,
        })
        upstream.emit('open')
        const frame = Buffer.alloc(1024)
        browser.emit('message', frame, true)
        expect(upstream.sent[0]).toBe(frame)
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'speech_start' })), false)
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'partial', text: 'wie spät' })), false)
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'final', text: 'wie spät ist es' })), false)
        await vi.waitFor(() => expect(browser.sent.map(raw => JSON.parse(raw).type)).toContain('done'))
        const types = browser.sent.map(raw => JSON.parse(raw).type)
        expect(types).toEqual(expect.arrayContaining(['ready', 'speech_start', 'partial', 'final', 'answer', 'audio', 'done']))
        // 2.87 Paket P: dritter Parameter = Strom für wortweises Sprechen.
        expect(answer).toHaveBeenCalledWith('wie spät ist es', expect.any(AbortSignal), expect.objectContaining({ onTextDelta: expect.any(Function), onToolRound: expect.any(Function) }))
        expect(speak).toHaveBeenCalledWith('Du hast gesagt: wie spät ist es.', 'female', expect.any(AbortSignal))
        browser.emit('close')
        expect(upstream.closed).toBe(true)
    })

    it('Stimme wechseln und Auflegen aus dem Browser', async () => {
        const browser = new FakeSocket()
        const upstream = new FakeSocket()
        const speak = vi.fn(async (text: string) => ({ audio: Buffer.from(text), mime: 'audio/wav', durationSec: 0.1 }))
        await runVoiceCallBridge(browser as any, { discover: async () => ({ endpoint: 'http://127.0.0.1:18795' } as any), openUpstream: () => upstream as any, answer: async () => 'Okay.', voice: 'female', speak })
        browser.emit('message', Buffer.from(JSON.stringify({ type: 'voice', voice: 'male' })), false)
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'final', text: 'hallo' })), false)
        await vi.waitFor(() => expect(speak).toHaveBeenCalledWith('Okay.', 'male', expect.any(AbortSignal)))
        browser.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false)
        expect(upstream.closed).toBe(true)
        expect(browser.closed).toBe(true)
    })
})

describe('voiceStatus', () => {
    it('liest die Einstellung und den gefundenen Dienst', async () => {
        const status = await voiceStatus(async () => null)
        expect(status.dienst.gefunden).toBe(false)
    })
})

describe('pipelineAnswer — Sprach-Zug mit Strom (2.87 Paket P)', () => {
    it('Textstücke und Werkzeuge der sprechbaren Runde kommen beim Anruf an; ohne Strom bleibt alles wie bisher', async () => {
        const { runSpeakable, speakableSink, noteVoiceToolDone } = await import('../voice/voice-turn-stream.js')
        const { pipelineAnswer } = await import('./voice-api.js')
        const seenSinks: boolean[] = []
        const handler = async () => {
            runSpeakable(() => {
                const sink = speakableSink()
                seenSinks.push(Boolean(sink))
                sink?.onToolRound(['ha_state'])
                sink?.onTextDelta('Es ist warm.')
            })
            noteVoiceToolDone('ha_state', true)
            // Außerhalb der sprechbaren Runde (z. B. Prüfaufruf) gibt es keinen Hörer.
            seenSinks.push(Boolean(speakableSink()))
            return 'Es ist warm.'
        }
        const answer = pipelineAnswer({ principalId: 'desktop-owner', clientId: 'web-1' }, () => handler)
        const stream = { onTextDelta: vi.fn(), onToolRound: vi.fn(), onToolDone: vi.fn() }
        expect(await answer('wie warm', new AbortController().signal, stream)).toBe('Es ist warm.')
        expect(stream.onTextDelta).toHaveBeenCalledWith('Es ist warm.')
        expect(stream.onToolRound).toHaveBeenCalledWith(['ha_state'])
        expect(stream.onToolDone).toHaveBeenCalledWith('ha_state', true)
        expect(seenSinks).toEqual([true, false])

        seenSinks.length = 0
        expect(await answer('wie warm', new AbortController().signal)).toBe('Es ist warm.')
        expect(seenSinks).toEqual([false, false])
    })
})
