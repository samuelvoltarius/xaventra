import { describe, expect, it, vi } from 'vitest'
import { AI_SERVICE_PROBES, type DiscoveredAIService } from '../mesh/ai-scanner.js'
import { findVoiceService, isPrivateVoiceHost, isXaventraVoiceHealth, VoiceServiceClient, VOICE_SERVICE_PORT } from './voice-mesh.js'

// Paket O: der Sprachdienst wird über den Scanner im Mesh gefunden (nicht hart
// verdrahtet) und nur im eigenen Netz benutzt („Privates nie in die Cloud“).

const health = { service: 'xaventra-voice', version: 1, ok: true, capabilities: ['stt', 'tts', 'stream'], voices: { female: 'Ramona', male: 'Thorsten' } }

function svc(host: string, over: Partial<DiscoveredAIService> = {}): DiscoveredAIService {
    return {
        id: `xaventra-voice@${host}:${VOICE_SERVICE_PORT}`, name: 'xaventra-voice', type: 'stt', provider: 'xaventra-voice', host, port: VOICE_SERVICE_PORT,
        endpoint: `http://${host}:${VOICE_SERVICE_PORT}`, models: [], status: 'running', lastSeen: '2026-10-06T10:00:00.000Z', ...over,
    }
}

describe('Scanner kennt den Sprachdienst', () => {
    it('Probe xaventra-voice erkennt nur die eigene Health-Antwort', () => {
        const probe = AI_SERVICE_PROBES.find(item => item.name === 'xaventra-voice')!
        expect(probe).toMatchObject({ type: 'stt', defaultPort: VOICE_SERVICE_PORT, healthEndpoint: '/health' })
        expect(probe.detectFn(JSON.stringify(health))).toBe(true)
        expect(probe.detectFn(JSON.stringify({ status: 'ok' }))).toBe(false)
        expect(probe.detectFn('<html>voice</html>')).toBe(false)
        expect(isXaventraVoiceHealth(JSON.stringify({ ...health, service: 'other' }))).toBe(false)
    })
})

describe('findVoiceService', () => {
    it('nimmt nur private Adressen (Tailnet, LAN, eigener Rechner), lokale zuerst', () => {
        expect(findVoiceService([svc('203.0.113.7')])).toBeNull()
        expect(findVoiceService([svc('100.64.0.12'), svc('127.0.0.1')])?.endpoint).toBe(`http://127.0.0.1:${VOICE_SERVICE_PORT}`)
        expect(findVoiceService([svc('100.64.0.12')])?.endpoint).toBe(`http://100.64.0.12:${VOICE_SERVICE_PORT}`)
        expect(findVoiceService([svc('192.168.1.20', { status: 'stopped' })])).toBeNull()
        expect(findVoiceService([{ ...svc('100.64.0.12'), name: 'whisper-server' }])).toBeNull()
        // Ein anderer Knoten meldet „localhost“: von hier aus wäre das der falsche Rechner.
        expect(findVoiceService([svc('127.0.0.1', { sourceNode: 'ns1', metadata: { source: 'mesh-advertised', nodeId: 'ns1' } })])).toBeNull()
    })
    it('isPrivateVoiceHost', () => {
        for (const host of ['127.0.0.1', 'localhost', '10.0.0.3', '192.168.1.2', '172.16.4.1', '100.64.0.1', '100.127.255.254']) expect(isPrivateVoiceHost(host), host).toBe(true)
        for (const host of ['203.0.113.7', '8.8.8.8', '100.128.0.1', 'voice.example.com', '']) expect(isPrivateVoiceHost(host), host).toBe(false)
    })
})

describe('VoiceServiceClient', () => {
    it('transcribe schickt die Audiodaten roh und liest den Text', async () => {
        const fetchImpl = vi.fn(async (_url: string, init: any) => {
            expect(init.method).toBe('POST')
            expect(init.headers['Content-Type']).toBe('audio/ogg')
            return new Response(JSON.stringify({ text: 'Mach das Licht aus', durationSec: 1.2 }), { status: 200 })
        })
        const client = new VoiceServiceClient('http://100.64.0.12:18795', fetchImpl as any)
        await expect(client.transcribe(Buffer.from('OggS'), 'audio/ogg')).resolves.toEqual({ text: 'Mach das Licht aus', durationSec: 1.2 })
        expect(fetchImpl.mock.calls[0][0]).toBe('http://100.64.0.12:18795/v1/transcribe')
    })
    it('speak liefert Audio + Dauer, Stimme Ramona ist Standard', async () => {
        const fetchImpl = vi.fn(async (_url: string, init: any) => {
            expect(JSON.parse(init.body)).toEqual({ text: 'Hallo', voice: 'female', format: 'ogg' })
            return new Response(new Uint8Array([79, 103, 103, 83]), { status: 200, headers: { 'Content-Type': 'audio/ogg', 'X-Duration-Sec': '0.8' } })
        })
        const client = new VoiceServiceClient('http://127.0.0.1:18795', fetchImpl as any)
        const spoken = await client.speak('Hallo', undefined, 'ogg')
        expect(spoken.mime).toBe('audio/ogg')
        expect(spoken.durationSec).toBeCloseTo(0.8)
        expect(spoken.audio.length).toBe(4)
    })
    it('weigert sich, mit einem öffentlichen Endpunkt zu reden', () => {
        expect(() => new VoiceServiceClient('http://203.0.113.7:18795', vi.fn() as any)).toThrow(/eigenen Netz/)
        expect(() => new VoiceServiceClient('https://voice.example.com', vi.fn() as any)).toThrow(/eigenen Netz/)
    })
    it('Fehler des Dienstes werden als Fehler gemeldet', async () => {
        const client = new VoiceServiceClient('http://127.0.0.1:18795', (async () => new Response('kaputt', { status: 500 })) as any)
        await expect(client.transcribe(Buffer.from('x'), 'audio/ogg')).rejects.toThrow(/500/)
    })
    it('streamUrl zeigt auf den WebSocket-Pfad', () => {
        expect(new VoiceServiceClient('http://100.64.0.12:18795', vi.fn() as any).streamUrl()).toBe('ws://100.64.0.12:18795/v1/stream')
    })
})
