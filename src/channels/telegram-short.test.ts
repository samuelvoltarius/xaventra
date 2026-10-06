import { beforeEach, describe, expect, it, vi } from 'vitest'

// Paket L 4: Telegram short everywhere — owner replies paged behind „Mehr“, a
// fixed main menu, bundled device questions keep their message.

vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { createApprovalCard, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'
import { deliverBundles } from '../core/card-bundle.js'

function adapter(allowFrom: string[] = ['111']) {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom, verifyAuthority: async () => true })
    let id = 50
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: ++id })),
        answerCallbackQuery: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
        editMessageReplyMarkup: vi.fn(async () => true),
        sendChatAction: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}
const press = (userId: number, data: string, messageId = 51) => ({
    id: `cb-${userId}`, data, from: { id: userId, username: `u${userId}` },
    message: { message_id: messageId, chat: { id: userId, type: 'private' }, text: 'x' },
})
const wall = Array.from({ length: 30 }, (_, i) => `Absatz ${i + 1}: ${'Text '.repeat(14)}`).join('\n')

describe('Telegram kurz mit Knöpfen', () => {
    it('a long reply to the owner is one short message with „Mehr“; the press edits it in place', async () => {
        const { instance, bot } = adapter()
        await instance.send({ channel: 'telegram', to: '111', content: wall } as any)
        expect(bot.sendMessage).toHaveBeenCalledTimes(1)
        const [, text, options] = bot.sendMessage.mock.calls[0] as any[]
        expect(text.length).toBeLessThanOrEqual(600)
        const more = options.reply_markup.inline_keyboard.flat().find((b: any) => /Mehr/.test(b.text))
        expect(more.callback_data).toMatch(/^nv:[a-f0-9]{16}$/)
        await (instance as any).handleFeedback(press(111, more.callback_data))
        const edit = bot.editMessageText.mock.calls.at(-1) as any[]
        expect(edit[1]).toMatchObject({ chat_id: '111', message_id: 51 })
        expect(String(edit[0])).toContain('Absatz')
        // a stranger cannot page the owner's message
        bot.editMessageText.mockClear()
        await (instance as any).handleFeedback(press(222, more.callback_data))
        expect(bot.editMessageText).not.toHaveBeenCalled()
    })

    it('a long reply to someone else keeps the old behaviour (no owner-only buttons)', async () => {
        const { instance, bot } = adapter(['111'])
        await instance.send({ channel: 'telegram', to: '333', content: wall } as any)
        expect((bot.sendMessage.mock.calls[0] as any[])[2]?.reply_markup).toBeUndefined()
    })

    it('/menu shows the fixed main menu with a traffic-light head', async () => {
        const { instance, bot } = adapter()
        await (instance as any).handleMessage({ message_id: 7, date: 1, text: '/menu', chat: { id: 111, type: 'private' }, from: { id: 111, username: 'owner' } })
        const [, text, options] = bot.sendMessage.mock.calls[0] as any[]
        expect(text).toMatch(/^🟢|^🟡|^🔴/)
        expect(options.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toEqual(['Status', expect.stringMatching(/^Braucht mich \(\d+\)$/), 'Geräte', 'Bericht', 'Mehr'])
    })

    it('a press in the device bundle answers that device, edits the bundle and reports the result once', async () => {
        const { ensureBuiltinCardExecutors } = await import('../core/approval-card-sources.js')
        await ensureBuiltinCardExecutors() // production executors first; the fake below replaces the device one
        registerCardExecutor({ kind: 'geraet-verbinden', async execute() { return { ok: true, message: 'Bitte hier anmelden: http://ha.example.com:8123/auth' } } })
        const make = (ref: string, kurz: string) => createApprovalCard({ art: 'geraet-verbinden', titel: `${kurz}?`, beleg: 'b', vorschlag: 'v', aktion: { kind: 'geraet-verbinden', ref }, buendel: 'geraete', kurz } as any)
        make('dev-00000000f1', 'Home Assistant'); make('dev-00000000f2', 'Hue Bridge')
        const { instance, bot } = adapter()
        const sender = { canSend: () => true, ownerChatIds: () => ['111'], send: (c: string, t: string, k: any) => instance.sendApprovalCard(c, t, k), edit: (c: string, m: number, t: string, k: any) => instance.editOwnerView(c, m, t, k) }
        await deliverBundles(sender)
        const [, , options] = bot.sendMessage.mock.calls.at(-1) as any[]
        const messageId = await bot.sendMessage.mock.results.at(-1)!.value.then((r: any) => r.message_id)
        const ha = options.reply_markup.inline_keyboard.flat().find((b: any) => /Home Assistant/.test(b.text))
        bot.sendMessage.mockClear()
        await (instance as any).handleFeedback(press(111, ha.callback_data, messageId))
        // the result (login address) comes once as its own short message
        expect(bot.sendMessage).toHaveBeenCalledTimes(1)
        expect(String((bot.sendMessage.mock.calls[0] as any[])[1])).toContain('ha.example.com')
        // the bundle message is edited: Hue keeps its button, Home Assistant is gone
        const edit = bot.editMessageText.mock.calls.at(-1) as any[]
        expect(edit[1].message_id).toBe(messageId)
        expect(String(edit[0])).toContain('Hue Bridge')
        expect(String(edit[0])).not.toContain('Home Assistant')
        unregisterCardExecutor('geraet-verbinden')
    })
})
