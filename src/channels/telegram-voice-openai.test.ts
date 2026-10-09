/**
 * 2.89.4: der echte Telegram-Spracheingang benutzt lokale OpenAI-kompatible
 * Dienste (STT `/v1/audio/transcriptions`, TTS `/v1/audio/speech`) und bietet
 * die Install-Karte nur an, wenn keiner antwortet. Fake-Schlüssel und
 * Doku-Adressen; kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const voice = vi.hoisted(() => ({
    service: null as null | { endpoint: string },
    transcribe: vi.fn(async () => ({ text: '' })),
    speak: vi.fn(async () => ({ audio: Buffer.from(''), mime: 'audio/ogg', durationSec: 0 })),
    whisper: null as null | { endpoint: string },
}))
vi.mock('../voice/voice-mesh.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    discoverVoiceService: vi.fn(async () => voice.service),
    VoiceServiceClient: class {
        constructor(public endpoint: string) {}
        transcribe = voice.transcribe
        speak = voice.speak
    },
}))
vi.mock('../voice/whisper-gpu.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    discoverWhisperGpu: vi.fn(async () => voice.whisper),
}))
vi.mock('../voice/voice-input.js', () => ({ transcribe: vi.fn(async () => { throw new Error('whisper missing') }) }))
vi.mock('../mesh/ai-scanner.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getDiscoveredServices: vi.fn(() => []),
}))
const toolbox = vi.hoisted(() => ({ requestToolboxInstall: vi.fn(async () => ({ ok: true })), defaultToolboxActionDeps: vi.fn(async () => ({})) }))
vi.mock('../install/toolbox-actions.js', () => toolbox)
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { speakReply, transcribeVoiceNote, voiceUnavailableNotice } from './telegram-voice.js'

const STT = 'http://127.0.0.1:18018'
const TTS = 'http://127.0.0.1:18019'
const OWNER = 222

let fetchImpl: ReturnType<typeof vi.fn>
beforeEach(() => {
    voice.service = null
    voice.whisper = null
    voice.transcribe.mockClear(); voice.speak.mockClear(); toolbox.requestToolboxInstall.mockClear()
    vi.stubEnv('XAVENTRA_STT_BASE_URL', STT)
    vi.stubEnv('XAVENTRA_TTS_BASE_URL', TTS)
    fetchImpl = vi.fn(async (url: any, init?: any) => {
        const text = String(url)
        if (text.startsWith(STT) && text.endsWith('/v1/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'whisper-1' }] }), { status: 200 })
        }
        if (text.startsWith(TTS) && text.endsWith('/v1/models')) {
            return new Response(JSON.stringify({ data: [{ id: 'pocket-tts-de' }] }), { status: 200 })
        }
        if (text.startsWith(STT) && text.endsWith('/v1/audio/transcriptions')) {
            return new Response(JSON.stringify({ text: 'Mach das Licht aus' }), { status: 200 })
        }
        if (text.startsWith(TTS) && text.endsWith('/v1/audio/speech')) {
            expect(init?.headers?.Authorization).toBeFalsy()
            return new Response(Buffer.from('OggS-pocket-tts'), { status: 200, headers: { 'Content-Type': 'audio/ogg' } })
        }
        return new Response('nope', { status: 404 })
    })
    // The Telegram transport must deliver audio successfully even when the
    // speech-service fixture deliberately returns errors or empty transcripts.
    vi.stubGlobal('fetch', (url: any, init?: any) => {
        if (String(url) === 'https://api.telegram.org/file/botfixture/voice/file.oga') {
            return Promise.resolve(new Response(Buffer.from('OggS-fixture'), { status: 200 }))
        }
        return fetchImpl(url, init)
    })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function adapter() {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom: [String(OWNER)], verifyAuthority: async () => true } as any)
    const bot = {
        getFile: vi.fn(async () => ({ file_path: 'voice/file.oga' })),
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        sendVoice: vi.fn(async () => ({ message_id: 2 })),
        sendChatAction: vi.fn(async () => true),
        answerCallbackQuery: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}
const voiceMsg = (duration = 5) => ({
    message_id: 5, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER },
    voice: { file_id: 'f1', mime_type: 'audio/ogg', duration },
})

describe('2.89.4: lokaler OpenAI-kompatibler Sprachdienst am echten Eingang', () => {
    it('versteht die Sprachnachricht über die lokale STT — ohne Install-Karte', async () => {
        const heard = await transcribeVoiceNote(Buffer.from('OggS'), 'audio/ogg', undefined, 5)
        expect(heard).toEqual({ text: 'Mach das Licht aus', via: 'openai-audio' })
        expect(fetchImpl.mock.calls.some(([url]: any[]) => String(url).endsWith('/v1/audio/transcriptions'))).toBe(true)

        const { instance, bot } = adapter()
        const handler = vi.fn(async () => undefined)
        instance.onMessage(handler)
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ content: 'Mach das Licht aus', channel: 'telegram' }))
        for (const call of bot.sendMessage.mock.calls) {
            expect(String((call as any[])[1] || '')).not.toMatch(/Sprachdienst einrichten|noch nicht anhören/)
            expect((call as any[])[2]?.reply_markup).toBeFalsy()
        }
    })

    it('spricht die Antwort über Pocket-TTS (/v1/audio/speech) ohne API-Key', async () => {
        fetchImpl.mockImplementation(async (url: any) => {
            const text = String(url)
            if (text.startsWith(STT) && text.endsWith('/v1/models')) {
                return new Response(JSON.stringify({ data: [{ id: 'whisper-1' }] }), { status: 200 })
            }
            if (text.startsWith(TTS) && text.endsWith('/v1/models')) {
                return new Response(JSON.stringify({ data: [{ id: 'pocket-tts-de' }] }), { status: 200 })
            }
            if (text.startsWith(STT) && text.endsWith('/v1/audio/transcriptions')) {
                return new Response(JSON.stringify({ text: 'Antworte per Sprache: wie spät ist es?' }), { status: 200 })
            }
            if (text.startsWith(TTS) && text.endsWith('/v1/audio/speech')) {
                return new Response(Buffer.from('OggS-pocket-tts'), { status: 200, headers: { 'Content-Type': 'audio/ogg' } })
            }
            return new Response('nope', { status: 404 })
        })
        const { instance, bot } = adapter()
        instance.onMessage(async (incoming: any) => {
            await instance.send({ to: incoming.to, content: 'Es ist **10 Uhr**.' } as any)
        })
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(bot.sendVoice).toHaveBeenCalledWith(String(OWNER), expect.any(Buffer), {}, expect.objectContaining({ contentType: 'audio/ogg' }))
        const speechCall = fetchImpl.mock.calls.find(([url]: any[]) => String(url).endsWith('/v1/audio/speech'))
        expect(speechCall).toBeTruthy()
        expect(JSON.parse((speechCall as any[])[1].body).input).toContain('10 Uhr')
    })

    it('ohne jegliche Antwort: Install-Karte — aber nicht, wenn einer antwortet', async () => {
        // nichts antwortet
        fetchImpl.mockImplementation(async () => new Response('nope', { status: 404 }))
        const { instance, bot } = adapter()
        instance.onMessage(vi.fn())
        await (instance as any).handleVoiceMessage(voiceMsg())
        const [chatId, text, options] = bot.sendMessage.mock.calls.at(-1) as any
        expect(chatId).toBe(String(OWNER))
        expect(text).toMatch(/Sprachnachricht/)
        expect(options.reply_markup.inline_keyboard.flat()).toEqual([expect.objectContaining({ callback_data: 'vo:install' })])

        // STT antwortet, liefert aber leeren Text → ehrlich, ohne Install-Karte
        bot.sendMessage.mockClear()
        fetchImpl.mockImplementation(async (url: any, init?: any) => {
            const textUrl = String(url)
            if (textUrl.endsWith('/v1/models')) {
                return new Response(JSON.stringify({ data: [{ id: 'whisper-1' }] }), { status: 200 })
            }
            if (textUrl.endsWith('/v1/audio/transcriptions')) {
                return new Response(JSON.stringify({ text: '' }), { status: 200 })
            }
            return new Response('nope', { status: 404 })
        })
        await (instance as any).handleVoiceMessage(voiceMsg())
        const last = bot.sendMessage.mock.calls.at(-1) as any
        expect(String(last[1])).toMatch(/antwortet gerade|nicht verstanden/)
        expect(last[2]?.reply_markup).toBeFalsy()
    })

    it('voiceUnavailableNotice: Install-Karte nur ohne antwortenden Dienst', () => {
        expect(voiceUnavailableNotice({ anyStt: true }).keyboard).toEqual([])
        expect(voiceUnavailableNotice({ anyTts: true }).keyboard.length).toBe(1)
        expect(voiceUnavailableNotice().keyboard[0][0].callback_data).toBe('vo:install')
    })

    it('speakReply bleibt ohne Dienst stumm und erfindet kein Audio', async () => {
        fetchImpl.mockImplementation(async () => new Response('nope', { status: 404 }))
        expect(await speakReply('Hallo', 'female')).toBeNull()
    })
})
