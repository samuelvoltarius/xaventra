import { describe, expect, it, vi } from 'vitest'

// 2.86 Paket N, Live-Befund 06.10. 16:29: die HA-Anmeldeadresse kam als Text,
// wurde nach 600 Zeichen abgeschnitten und `state` (48 hex) vom Owner-Filter
// entfernt. Jetzt: ein Satz + EIN URL-Knopf, die Adresse unverändert.

vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { createApprovalCard, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'
import { deliverBundles } from '../core/card-bundle.js'

function adapter() {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true })
    let id = 50
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: ++id })), answerCallbackQuery: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true), editMessageReplyMarkup: vi.fn(async () => true), sendChatAction: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}

describe('Anmeldung als URL-Knopf', () => {
    it('ein Satz + Knopf „Bei Home Assistant anmelden“; die Adresse bleibt vollständig und unverändert', async () => {
        const { ensureBuiltinCardExecutors } = await import('../core/approval-card-sources.js')
        await ensureBuiltinCardExecutors()
        const state = 'a1'.repeat(24)
        const url = `http://ha.example.com:8123/auth/authorize?response_type=code&client_id=${encodeURIComponent('http://127.0.0.1:3011/')}&redirect_uri=${encodeURIComponent('http://127.0.0.1:3011/verbindungen/rueckkehr')}&state=${state}&code_challenge=${'Z'.repeat(43)}&code_challenge_method=S256`
        registerCardExecutor({ kind: 'geraet-verbinden', async execute() { return { ok: true, message: 'Ein Schritt noch: Bei Home Assistant anmelden. Der Knopf gilt eine Viertelstunde.', link: { label: 'Bei Home Assistant anmelden', url } } } })
        createApprovalCard({ art: 'geraet-verbinden', titel: 'Home Assistant verbinden?', beleg: 'b', vorschlag: 'v', aktion: { kind: 'geraet-verbinden', ref: 'dev-00000000f1' }, buendel: 'geraete', kurz: 'Home Assistant' } as any)
        const { instance, bot } = adapter()
        await deliverBundles({ canSend: () => true, ownerChatIds: () => ['111'], send: (c: string, t: string, k: any) => instance.sendApprovalCard(c, t, k), edit: (c: string, m: number, t: string, k: any) => instance.editOwnerView(c, m, t, k) })
        const [, , options] = bot.sendMessage.mock.calls.at(-1) as any[]
        const ha = options.reply_markup.inline_keyboard.flat().find((b: any) => /Home Assistant/.test(b.text))
        bot.sendMessage.mockClear()
        await (instance as any).handleFeedback({ id: 'cb', data: ha.callback_data, from: { id: 111, username: 'o' }, message: { message_id: 51, chat: { id: 111, type: 'private' }, text: 'x' } })
        expect(bot.sendMessage).toHaveBeenCalledTimes(1)
        const [, text, opts] = bot.sendMessage.mock.calls[0] as any[]
        expect(text).toBe('Ein Schritt noch: Bei Home Assistant anmelden. Der Knopf gilt eine Viertelstunde.')
        expect(opts.reply_markup.inline_keyboard).toEqual([[{ text: 'Bei Home Assistant anmelden', url }]])
        expect(new URL(opts.reply_markup.inline_keyboard[0][0].url).searchParams.get('state')).toBe(state)
        unregisterCardExecutor('geraet-verbinden')
    }, 30_000)
})
