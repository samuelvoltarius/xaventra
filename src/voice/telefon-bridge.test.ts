import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AS_AUDIO, AS_HANGUP, AS_UUID, encodeFrame, FrameReader, resamplePcm16, wavToPcm16 } from './audiosocket.js'
import { startTelefonBridge, startTelefonIfReady, type TelefonBridge } from './telefon-bridge.js'
import type { TelefonConfig } from './telefon-config.js'

// 2.87 Paket P: Telefon über eine vorhandene Telefonanlage (Asterisk AudioSocket).
// Nur 127.0.0.1, Ports im Test zufällig (0). Kein Anruf, kein Netz nach außen.

const OWNER = '+4312345678' // Beispielnummer (Doku), kein echter Anschluss

function config(over: Partial<TelefonConfig> = {}): TelefonConfig {
    return {
        version: 1, aktiv: true, weg: 'asterisk',
        sip: { server: '', port: 5060, transport: 'udp', login: '' },
        ownerNummern: [OWNER],
        asterisk: { audioSocketPort: 0, anmeldePort: 0, ariApp: 'xaventra' },
        ...over,
    }
}

function wav(samples: number, rate = 16000): Buffer {
    const data = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2)
    const head = Buffer.alloc(44)
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
    head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
    head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
    head.write('data', 36); head.writeUInt32LE(data.length, 40)
    return Buffer.concat([head, data])
}

class FakeUpstream extends EventEmitter {
    readyState = 1
    OPEN = 1
    sent: Buffer[] = []
    closed = false
    send(data: Buffer) { this.sent.push(data) }
    close() { this.closed = true; this.emit('close') }
}

let bridge: TelefonBridge | null = null
afterEach(async () => { await bridge?.stop(); bridge = null })

async function ticket(port: number, number: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}/anruf?nummer=${encodeURIComponent(number)}`)
    expect(response.status).toBe(200)
    return (await response.text()).trim()
}

function uuidBytes(id: string): Buffer { return Buffer.from(id.replace(/-/g, ''), 'hex') }

function asterisk(port: number) {
    const socket: Socket = connect({ host: '127.0.0.1', port })
    const reader = new FrameReader()
    const frames: Array<{ type: number; payload: Buffer }> = []
    socket.on('data', chunk => { frames.push(...reader.push(chunk)) })
    const ended = new Promise<void>(resolve => socket.on('close', () => resolve()))
    return { socket, frames, ended, opened: new Promise<void>(resolve => socket.once('connect', () => resolve())) }
}

describe('Telefon ohne Owner-Konfiguration', () => {
    it('nichts lauscht: keine Server, kein Port', async () => {
        const createServer = vi.fn()
        expect(await startTelefonIfReady(config({ aktiv: false }), { createServers: createServer } as any)).toBeNull()
        expect(await startTelefonIfReady(config({ ownerNummern: [] }), { createServers: createServer } as any)).toBeNull()
        expect(await startTelefonIfReady(config({ weg: 'direkt' }), { createServers: createServer } as any)).toBeNull()
        expect(createServer).not.toHaveBeenCalled()
    })
})

describe('Telefon über Asterisk-AudioSocket', () => {
    function deps(over: Record<string, unknown> = {}) {
        const upstream = new FakeUpstream()
        const answer = vi.fn(async (text: string) => `Du hast gesagt: ${text}.`)
        const answerFor = vi.fn(() => answer)
        const speak = vi.fn(async (text: string) => ({ audio: wav(1600), mime: 'audio/wav', durationSec: 0.1, text }))
        return {
            upstream, answer, answerFor, speak,
            deps: {
                discover: async () => ({ endpoint: 'http://127.0.0.1:18795' }),
                openUpstream: () => upstream as any,
                speak, answerFor, voice: 'female' as const, frameIntervalMs: 1, ...over,
            },
        }
    }

    it('lauscht nur auf 127.0.0.1', async () => {
        const { deps: d } = deps()
        bridge = await startTelefonBridge(config(), d)
        expect(bridge.addresses.audioSocket.address).toBe('127.0.0.1')
        expect(bridge.addresses.anmeldung.address).toBe('127.0.0.1')
    })

    it('fremde Nummer: höflich ablehnen (nur Ansage, keine Pipeline), dann auflegen', async () => {
        const { deps: d, answerFor, speak } = deps()
        bridge = await startTelefonBridge(config(), d)
        const id = await ticket(bridge.addresses.anmeldung.port, '+4319999999')
        const call = asterisk(bridge.addresses.audioSocket.port)
        await call.opened
        call.socket.write(encodeFrame(AS_UUID, uuidBytes(id)))
        await call.ended
        expect(speak).toHaveBeenCalledWith(expect.stringContaining('leider nicht'), 'female', expect.any(AbortSignal))
        expect(call.frames.some(frame => frame.type === AS_AUDIO)).toBe(true)
        expect(call.frames.at(-1)!.type).toBe(AS_HANGUP)
        expect(answerFor).not.toHaveBeenCalled()
    })

    it('unterdrückte Nummer wird wie eine fremde behandelt', async () => {
        const { deps: d, answerFor } = deps()
        bridge = await startTelefonBridge(config(), d)
        const id = await ticket(bridge.addresses.anmeldung.port, 'anonymous')
        const call = asterisk(bridge.addresses.audioSocket.port)
        await call.opened
        call.socket.write(encodeFrame(AS_UUID, uuidBytes(id)))
        await call.ended
        expect(answerFor).not.toHaveBeenCalled()
    })

    it('unbekannte oder doppelt benutzte Kennung: sofort auflegen', async () => {
        const { deps: d } = deps()
        bridge = await startTelefonBridge(config(), d)
        const call = asterisk(bridge.addresses.audioSocket.port)
        await call.opened
        call.socket.write(encodeFrame(AS_UUID, Buffer.alloc(16, 7)))
        await call.ended
        expect(call.frames.map(frame => frame.type)).toEqual([AS_HANGUP])
    })

    it('Owner-Nummer: Audio → Sprachdienst (16 kHz), Endtext → Antwort → Audio zurück (8 kHz)', async () => {
        const { deps: d, upstream, answer, answerFor } = deps()
        bridge = await startTelefonBridge(config(), d)
        const id = await ticket(bridge.addresses.anmeldung.port, '0043 1 2345678')
        const call = asterisk(bridge.addresses.audioSocket.port)
        await call.opened
        call.socket.write(encodeFrame(AS_UUID, uuidBytes(id)))
        await vi.waitFor(() => expect(answerFor).toHaveBeenCalledWith('+4312345678'))
        call.socket.write(encodeFrame(AS_AUDIO, Buffer.alloc(320)))
        await vi.waitFor(() => expect(upstream.sent.length).toBeGreaterThan(0))
        expect(upstream.sent[0].length).toBe(640) // 20 ms bei 16 kHz
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'speech_start' })), false)
        upstream.emit('message', Buffer.from(JSON.stringify({ type: 'final', text: 'läuft alles' })), false)
        await vi.waitFor(() => expect(call.frames.filter(frame => frame.type === AS_AUDIO).length).toBeGreaterThan(0))
        expect(answer).toHaveBeenCalledWith('läuft alles', expect.any(AbortSignal), expect.anything())
        expect(call.frames.find(frame => frame.type === AS_AUDIO)!.payload.length).toBe(320)
        call.socket.write(encodeFrame(AS_HANGUP))
        await vi.waitFor(() => expect(upstream.closed).toBe(true))
    })

    it('ausgehend: nur die Nummer, die Xaventra gerade selbst gewählt hat, wird zum Gespräch', async () => {
        const { allowOutbound } = await import('./telefon-bridge.js')
        const { deps: d, answerFor } = deps()
        bridge = await startTelefonBridge(config(), d)
        allowOutbound('+43 1 7654321')
        const port = bridge.addresses.anmeldung.port
        const fremd = await ticket(port, '+4319999999')
        const ok = await (await fetch(`http://127.0.0.1:${port}/anruf?richtung=raus&nummer=${encodeURIComponent('+4317654321')}`)).text()
        const again = await (await fetch(`http://127.0.0.1:${port}/anruf?richtung=raus&nummer=${encodeURIComponent('+4317654321')}`)).text()
        for (const [id, expectConversation] of [[ok, true], [again, false], [fremd, false]] as const) {
            answerFor.mockClear()
            const call = asterisk(bridge.addresses.audioSocket.port)
            await call.opened
            call.socket.write(encodeFrame(AS_UUID, uuidBytes(id)))
            if (expectConversation) {
                await vi.waitFor(() => expect(answerFor).toHaveBeenCalledWith('+4317654321'))
                call.socket.write(encodeFrame(AS_HANGUP))
            } else {
                await call.ended
                expect(answerFor).not.toHaveBeenCalled()
            }
            call.socket.destroy()
        }
    })

    it('Kennung gilt nur kurz und nur einmal', async () => {
        let now = 1_000
        const { deps: d } = deps({ now: () => now })
        bridge = await startTelefonBridge(config(), d)
        const id = await ticket(bridge.addresses.anmeldung.port, OWNER)
        now += 31_000
        const call = asterisk(bridge.addresses.audioSocket.port)
        await call.opened
        call.socket.write(encodeFrame(AS_UUID, uuidBytes(id)))
        await call.ended
        expect(call.frames.map(frame => frame.type)).toEqual([AS_HANGUP])
    })

    it('stop() schließt alle Ports', async () => {
        const { deps: d } = deps()
        bridge = await startTelefonBridge(config(), d)
        const port = bridge.addresses.anmeldung.port
        await bridge.stop()
        bridge = null
        await expect(fetch(`http://127.0.0.1:${port}/anruf?nummer=1`)).rejects.toThrow()
    })
})

describe('Audio-Umrechnung', () => {
    it('WAV 16 kHz → 8 kHz halbiert die Länge', () => {
        const { pcm, sampleRate } = wavToPcm16(wav(1600))
        expect(sampleRate).toBe(16000)
        expect(resamplePcm16(pcm, 16000, 8000).length).toBe(1600)
        expect(resamplePcm16(Buffer.alloc(320), 8000, 16000).length).toBe(640)
    })
})
