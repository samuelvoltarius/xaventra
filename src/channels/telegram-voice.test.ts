import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.86 Paket O: Sprachnachrichten in Telegram über den Sprachdienst im Mesh,
// Antwort als Text und auf Wunsch zusätzlich als Sprachnachricht (Ramona).
// Kein Netz: Sprachdienst, Whisper und Werkzeugkasten sind Attrappen.

const voice = vi.hoisted(() => ({
    service: null as null | { endpoint: string },
    transcribe: vi.fn(async () => ({ text: 'Mach das Licht aus' })),
    speak: vi.fn(async () => ({ audio: Buffer.from('OggS-antwort'), mime: 'audio/ogg', durationSec: 1 })),
}))
vi.mock('../voice/voice-mesh.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    discoverVoiceService: vi.fn(async () => voice.service),
    VoiceServiceClient: class { constructor(public endpoint: string) {} transcribe = voice.transcribe; speak = voice.speak },
}))
vi.mock('../voice/voice-input.js', () => ({ transcribe: vi.fn(async () => { throw new Error('whisper missing') }) }))
const toolbox = vi.hoisted(() => ({ requestToolboxInstall: vi.fn(async () => ({ ok: true, message: 'Karte angelegt.' })), defaultToolboxActionDeps: vi.fn(async () => ({})) }))
vi.mock('../install/toolbox-actions.js', () => toolbox)
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { readVoicePrefs } from '../voice/voice-prefs.js'

let root = ''
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-voice-'))
    process.env.NOVA_RUNTIME_ROOT = root
    voice.service = { endpoint: 'http://100.64.0.12:18795' }
    voice.transcribe.mockClear(); voice.speak.mockClear(); toolbox.requestToolboxInstall.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([79, 103, 103, 83]).buffer })))
})
afterEach(() => { vi.unstubAllGlobals(); delete process.env.NOVA_RUNTIME_ROOT; rmSync(root, { recursive: true, force: true }) })

const OWNER = 222
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
const voiceMsg = () => ({ message_id: 5, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, voice: { file_id: 'f1', mime_type: 'audio/ogg' } })

describe('Telegram-Sprachnachrichten über den Sprachdienst im Mesh', () => {
    it('versteht die Sprachnachricht über den gefundenen Dienst und gibt den Text in die Pipeline', async () => {
        const { instance, bot } = adapter()
        const handler = vi.fn(async () => undefined)
        instance.onMessage(handler)
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(voice.transcribe).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg')
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ content: 'Mach das Licht aus', channel: 'telegram' }))
        // Standard: Antwort nur als Text
        expect(bot.sendVoice).not.toHaveBeenCalled()
    })

    it('„antworte per Sprache“: Antwort zusätzlich als Sprachnachricht (Ramona, Ogg)', async () => {
        voice.transcribe.mockResolvedValueOnce({ text: 'Antworte per Sprache: wie spät ist es?' })
        const { instance, bot } = adapter()
        instance.onMessage(async (incoming: any) => { await instance.send({ to: incoming.to, content: 'Es ist **10 Uhr**.' } as any) })
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(bot.sendMessage).toHaveBeenCalled()
        expect(voice.speak).toHaveBeenCalledWith('Es ist 10 Uhr.', 'female', 'ogg')
        expect(bot.sendVoice).toHaveBeenCalledWith(String(OWNER), expect.any(Buffer), {}, expect.objectContaining({ contentType: 'audio/ogg' }))
        expect(readVoicePrefs().replyByVoice).toBe(false) // einmaliger Wunsch, keine Dauer-Einstellung
    })

    it('Owner-Einstellung „immer per Sprache“ bleibt und gilt für die nächste Sprachnachricht', async () => {
        voice.transcribe.mockResolvedValueOnce({ text: 'Antworte ab jetzt immer per Sprache' })
        const { instance, bot } = adapter()
        instance.onMessage(async (incoming: any) => { await instance.send({ to: incoming.to, content: 'Gern.' } as any) })
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(readVoicePrefs().replyByVoice).toBe(true)
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(bot.sendVoice).toHaveBeenCalledTimes(2)
    })

    it('ohne Sprachdienst und ohne Whisper: ein ehrlicher Satz und ein Knopf zum Einrichten', async () => {
        voice.service = null
        const { instance, bot } = adapter()
        const handler = vi.fn()
        instance.onMessage(handler)
        await (instance as any).handleVoiceMessage(voiceMsg())
        expect(handler).not.toHaveBeenCalled()
        const [chatId, text, options] = bot.sendMessage.mock.calls.at(-1) as any
        expect(chatId).toBe(String(OWNER))
        expect(text).toMatch(/Sprachnachricht/)
        expect(text).not.toMatch(/Whisper|STT|Install-Katalog/)
        expect(options.reply_markup.inline_keyboard.flat()).toEqual([expect.objectContaining({ callback_data: 'vo:install' })])
    })

    it('Knopf „Sprachdienst einrichten“: nur der Owner legt die Werkzeugkasten-Karte an', async () => {
        const { instance, bot } = adapter()
        await (instance as any).handleFeedback({ id: 'q1', data: 'vo:install', from: { id: OWNER }, message: { chat: { id: OWNER }, message_id: 9 } })
        expect(toolbox.requestToolboxInstall).toHaveBeenCalledWith('sprachdienst:de', expect.anything())
        expect(bot.answerCallbackQuery).toHaveBeenCalled()
        toolbox.requestToolboxInstall.mockClear()
        await (instance as any).handleFeedback({ id: 'q2', data: 'vo:install', from: { id: 999 }, message: { chat: { id: 999 }, message_id: 9 } })
        expect(toolbox.requestToolboxInstall).not.toHaveBeenCalled()
    })
})
