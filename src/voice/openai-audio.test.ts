/**
 * 2.89.4: OpenAI-kompatible Sprachdienste im eigenen Netz werden erkannt,
 * live geprüft und benutzt — statt „Sprachdienst installieren“ anzubieten.
 * Kein Netz: nur Doku-Adressen (127.0.0.x) und Attrappen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_SERVICE_PROBES } from '../mesh/ai-scanner.js'
import {
    discoverOpenAiAudio, envSpeechEndpoints, findOpenAiAudio, isOpenAiSttHealth, isPocketTtsHealth,
    looksLikeOpenAiAudio, OPENAI_AUDIO_STT_NAME, OPENAI_AUDIO_STT_PORT, openAiAudioStreamUrl,
    POCKET_TTS_NAME, POCKET_TTS_PORT, probeOpenAiAudio, probeSpeechServices, speakWithOpenAiTts,
} from './openai-audio.js'

const TTS_MODELS = JSON.stringify({ data: [{ id: 'pocket-tts-de' }, { id: 'kokoro-v1' }] })
const STT_MODELS = JSON.stringify({ data: [{ id: 'whisper-1' }, { id: 'whisper-large-v3' }] })
const LLM_MODELS = JSON.stringify({ data: [{ id: 'llama3' }] })

/** Eigenes Netz im Test: RFC1918 + Loopback (so auch produktiv erlaubt). */
const heim = (host: string) => host.startsWith('127.0.0.') || host === '127.0.0.1' || host === 'localhost'

beforeEach(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('2.89.4: OpenAI-kompatible Sprachdienste erkennen', () => {
    it('never forwards ambient cloud credentials to discovered local synthesis', async () => {
        vi.stubEnv('OPENAI_API_KEY', 'fixture-cloud')
        vi.stubEnv('OPENAI_TTS_API_KEY', 'fixture-cloud-tts')
        const fetchImpl = vi.fn(async () => new Response(Buffer.from('audio')))
        await speakWithOpenAiTts('http://127.0.0.1:5002', 'Hallo', { fetchImpl: fetchImpl as any })
        expect((fetchImpl.mock.calls[0] as any)[1].headers.Authorization).toBeUndefined()
    })
    it('preserves explicitly supplied endpoint credentials without redirect forwarding', async () => {
        const fetchImpl = vi.fn(async () => new Response(Buffer.from('audio')))
        await speakWithOpenAiTts('http://127.0.0.1:5002', 'Hallo', { fetchImpl: fetchImpl as any, apiKey: 'fixture-local' })
        expect((fetchImpl.mock.calls[0] as any)[1]).toMatchObject({ headers: { Authorization: 'Bearer fixture-local' }, redirect: 'error' })
    })
    it('does not attach a caller credential while discovering unrelated endpoints', async () => {
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.1:5002')
        const fetchImpl = vi.fn(async () => new Response(TTS_MODELS))
        await discoverOpenAiAudio('tts', { services: [], fetchImpl: fetchImpl as any, apiKey: 'fixture-local' })
        expect((fetchImpl.mock.calls[0] as any)[1].headers.Authorization).toBeUndefined()
    })
    it('der KI-Scanner hat Proben für Pocket-TTS und OpenAI-STT', () => {
        const tts = AI_SERVICE_PROBES.find(item => item.name === POCKET_TTS_NAME)!
        expect(tts).toMatchObject({ type: 'tts', defaultPort: POCKET_TTS_PORT, healthEndpoint: '/v1/models' })
        expect(tts.detectFn(TTS_MODELS)).toBe(true)
        expect(tts.detectFn(STT_MODELS)).toBe(false)
        expect(tts.detectFn(LLM_MODELS)).toBe(false)
        expect(tts.parseModelsFn!(TTS_MODELS)).toEqual(['pocket-tts-de', 'kokoro-v1'])

        const stt = AI_SERVICE_PROBES.find(item => item.name === OPENAI_AUDIO_STT_NAME)!
        expect(stt).toMatchObject({ type: 'stt', defaultPort: OPENAI_AUDIO_STT_PORT, healthEndpoint: '/v1/models' })
        expect(stt.detectFn(STT_MODELS)).toBe(true)
        expect(stt.detectFn(TTS_MODELS)).toBe(false)
        expect(isPocketTtsHealth('kaputt')).toBe(false)
        expect(isOpenAiSttHealth('kaputt')).toBe(false)
    })

    it('Env-Adressen zuerst, nur eigene Netze', () => {
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.50:5002')
        vi.stubEnv('POCKET_TTS_URL', 'http://127.0.0.50:5002')
        vi.stubEnv('OPENAI_TTS_BASE_URL', 'https://api.openai.com/v1')
        vi.stubEnv('XAVENTRA_STT_BASE_URL', 'http://127.0.0.1:8018')
        expect(envSpeechEndpoints('tts')).toEqual(['http://127.0.0.50:5002'])
        expect(envSpeechEndpoints('stt')).toEqual(['http://127.0.0.1:8018'])
    })

    it('nur ein laufender Dienst im eigenen Netz, eigener Rechner zuerst', () => {
        const base = { id: 'x', type: 'tts' as const, provider: 'pocket-tts', models: ['pocket-tts-de'], status: 'running' as const, lastSeen: '' }
        expect(findOpenAiAudio([{ ...base, name: POCKET_TTS_NAME, host: '203.0.113.5', endpoint: 'http://203.0.113.5:5002', port: 5002 }], 'tts', heim)).toBeNull()
        expect(findOpenAiAudio([{ ...base, name: POCKET_TTS_NAME, host: '127.0.0.40', endpoint: 'http://127.0.0.40:5002', port: 5002, sourceNode: 'node-fixture' }], 'tts', heim)?.endpoint).toBe('http://127.0.0.40:5002')
        const local = { ...base, name: POCKET_TTS_NAME, host: '127.0.0.1', endpoint: 'http://127.0.0.1:5002', port: 5002, sourceNode: 'local' }
        const remote = { ...base, name: POCKET_TTS_NAME, host: '127.0.0.40', endpoint: 'http://127.0.0.40:5002', port: 5002, sourceNode: 'node-fixture' }
        expect(findOpenAiAudio([remote, local], 'tts', heim)?.endpoint).toBe('http://127.0.0.1:5002')
        expect(looksLikeOpenAiAudio({ ...base, name: 'whisper-gpu', type: 'stt', models: ['whisper-1'], host: '127.0.0.1', endpoint: 'http://127.0.0.1:8017', port: 8017 }, 'stt')).toBe(true)
    })

    it('Live-Sonde: antwortet der Dienst in diesem Lauf?', async () => {
        const fetchImpl = vi.fn(async (url: any) => new Response(String(url).endsWith('/v1/models') ? TTS_MODELS : 'nope', { status: 200 }))
        await expect(probeOpenAiAudio('http://127.0.0.50:5002', 'tts', { fetchImpl: fetchImpl as any, allowHost: heim }))
            .resolves.toMatchObject({ ok: true, models: ['pocket-tts-de', 'kokoro-v1'] })
        const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
        await expect(probeOpenAiAudio('http://127.0.0.50:5002', 'tts', { fetchImpl: down as any, allowHost: heim }))
            .resolves.toMatchObject({ ok: false })
        await expect(probeOpenAiAudio('http://203.0.113.5:5002', 'tts', { fetchImpl: vi.fn() as any }))
            .resolves.toMatchObject({ ok: false })
    })

    it('verbindet den ersten Dienst, der live antwortet (Env vor Scan)', async () => {
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.60:5002')
        const fetchImpl = vi.fn(async (url: any) => {
            const text = String(url)
            if (text.includes('127.0.0.60') && text.endsWith('/v1/models')) return new Response(TTS_MODELS, { status: 200 })
            if (text.includes('127.0.0.70') && text.endsWith('/v1/models')) return new Response(TTS_MODELS, { status: 200 })
            return new Response('nope', { status: 404 })
        })
        const found = await discoverOpenAiAudio('tts', {
            fetchImpl: fetchImpl as any, allowHost: heim,
            services: [{ id: 'a', name: POCKET_TTS_NAME, type: 'tts', provider: 'pocket-tts', host: '127.0.0.70', port: 5002, endpoint: 'http://127.0.0.70:5002', models: [], status: 'running', lastSeen: '' }],
        })
        expect(found).toMatchObject({ endpoint: 'http://127.0.0.60:5002', source: 'env', kind: 'tts' })
    })

    it('Sprachausgabe über /v1/audio/speech ohne API-Key im eigenen Netz', async () => {
        const fetchImpl = vi.fn(async () => new Response(Buffer.from('OggS-pocket'), { status: 200, headers: { 'Content-Type': 'audio/ogg' } }))
        const spoken = await speakWithOpenAiTts('http://127.0.0.50:5002', 'Hallo', { fetchImpl: fetchImpl as any, allowHost: heim, voice: 'female' })
        expect(spoken.audio.equals(Buffer.from('OggS-pocket'))).toBe(true)
        const [url, init] = fetchImpl.mock.calls[0] as any
        expect(String(url)).toBe('http://127.0.0.50:5002/v1/audio/speech')
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body)).toMatchObject({ input: 'Hallo', response_format: 'opus' })
        expect(String(init.headers.Authorization || '')).toBe('')
    })

    it('nie außerhalb des eigenen Netzes', async () => {
        await expect(speakWithOpenAiTts('http://203.0.113.5:5002', 'Hallo', { fetchImpl: vi.fn() as any }))
            .rejects.toThrow(/eigenen Netz/)
    })

    it('Stream-Adresse nur, wenn vorhanden und privat', () => {
        expect(openAiAudioStreamUrl('http://127.0.0.50:5002', true)).toBe('ws://127.0.0.50:5002/v1/stream')
        expect(openAiAudioStreamUrl('http://127.0.0.50:5002', false)).toBeNull()
        expect(openAiAudioStreamUrl('https://api.openai.com/v1', true)).toBeNull()
    })
})

describe('2.89.4: „läuft“ nur mit Live-Beleg', () => {
    it('does not restore an unscoped credential in the second discovered STT probe', async () => {
        vi.stubEnv('XAVENTRA_STT_BASE_URL', 'http://127.0.0.1:8018')
        const fetchImpl = vi.fn(async () => new Response(STT_MODELS))
        await probeSpeechServices({ fetchImpl: fetchImpl as any, apiKey: 'fixture-local' })
        expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
        for (const [, init] of fetchImpl.mock.calls as any) expect(init?.headers?.Authorization).toBeUndefined()
    })
    it('meldet STT und TTS nur, wenn eine Sonde in diesem Lauf antwortet', async () => {
        vi.stubEnv('XAVENTRA_STT_BASE_URL', 'http://127.0.0.1:8018')
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.1:5002')
        const fetchImpl = vi.fn(async (url: any) => {
            const text = String(url)
            if (text.includes(':8018')) return new Response(STT_MODELS, { status: 200 })
            if (text.includes(':5002')) return new Response(TTS_MODELS, { status: 200 })
            return new Response('nope', { status: 404 })
        })
        const probe = await probeSpeechServices({ fetchImpl: fetchImpl as any, allowHost: heim })
        expect(probe).toMatchObject({ anyStt: true, anyTts: true })
        expect(probe.details.join(' ')).toMatch(/stt/)
    })

    it('ohne Antwort keine Behauptung, dass etwas läuft', async () => {
        const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
        const probe = await probeSpeechServices({ fetchImpl: down as any, allowHost: heim })
        expect(probe.anyStt).toBe(false)
        expect(probe.anyTts).toBe(false)
    })
})
