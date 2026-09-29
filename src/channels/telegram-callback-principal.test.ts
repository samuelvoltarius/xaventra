import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// INT-1 regression: inline-button callbacks must carry the pressing user's
// principal and role into handleCommand. Before, handleCommand was called
// without a principal, so the central role gate treated every button press
// (including the owner's) as guest.

const mu = vi.hoisted(() => ({
    roles: new Map<string, 'owner' | 'admin' | 'user' | 'guest' | 'blocked'>(),
    initMultiUser: vi.fn(),
    checkAuth: vi.fn((userId: string) => {
        const permission = mu.roles.get(userId) || 'guest'
        return { allowed: permission !== 'blocked', permission, isNewUser: false, user: { id: userId } }
    }),
}))
vi.mock('../users/multi-user-middleware.js', () => ({ initMultiUser: mu.initMultiUser, checkAuth: mu.checkAuth }))

const seen = vi.hoisted(() => ({ contexts: [] as any[] }))
vi.mock('../core/slash-commands.js', async importOriginal => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        handleCommand: vi.fn(async (...args: any[]) => {
            seen.contexts.push(args[5])
            return actual.handleCommand(...args)
        }),
    }
})
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'

function adapter(allowFrom: string[] = []) {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom, verifyAuthority: async () => true })
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        answerCallbackQuery: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}

const press = (userId: number, data: string, chatId = userId, chatType = 'private') => ({
    id: `cb-${userId}-${data}`, data, from: { id: userId, username: `u${userId}` },
    message: { message_id: 7, chat: { id: chatId, type: chatType }, text: 'menu' },
})

beforeEach(() => {
    mu.roles.clear()
    mu.checkAuth.mockClear()
    seen.contexts.length = 0
    ;(globalThis as any).__novaState = {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: { switchModel: vi.fn(async () => true) }, internalLlm: null, memory: null, learning: null,
        tools: null, resilience: null, startTime: Date.now(), config: {},
    }
})
afterEach(() => { delete (globalThis as any).__novaState })

describe('Telegram callback buttons use the pressing user\'s role (INT-1)', () => {
    it('lets the owner use an owner-only command button', async () => {
        mu.roles.set('111', 'owner')
        const { instance, bot } = adapter(['111'])
        await (instance as any).handleFeedback(press(111, 'cmd_some-owner-only-command'))
        expect(seen.contexts).toHaveLength(1)
        expect(seen.contexts[0]).toMatchObject({ channel: 'telegram', rawUserId: '111', principalId: '111', permission: 'owner' })
        const texts = bot.sendMessage.mock.calls.map((call: any[]) => String(call[1]))
        expect(texts.some(text => text.includes('🔒'))).toBe(false)
    })

    it('blocks a guest pressing an owner-only command button in a group', async () => {
        mu.roles.set('111', 'owner')
        mu.roles.set('222', 'guest')
        const { instance, bot } = adapter(['111'])
        await (instance as any).handleFeedback(press(222, 'cmd_some-owner-only-command', -500, 'group'))
        expect(seen.contexts[0]).toMatchObject({ rawUserId: '222', permission: 'guest' })
        const texts = bot.sendMessage.mock.calls.map((call: any[]) => String(call[1]))
        expect(texts.some(text => text.includes('🔒'))).toBe(true)
    })

    it('derives the role from query.from, not from the chat the button lives in', async () => {
        mu.roles.set('111', 'owner')
        mu.roles.set('222', 'guest')
        const { instance } = adapter([])
        // Button sits in the owner's chat id space but is pressed by the guest.
        await (instance as any).handleFeedback(press(222, 'cmd_status', 111, 'group'))
        expect(seen.contexts[0]).toMatchObject({ rawUserId: '222', permission: 'guest' })
    })

    it('refuses a DM button press from a sender outside the allowlist without calling handleCommand', async () => {
        mu.roles.set('333', 'owner')
        const { instance, bot } = adapter(['111'])
        await (instance as any).handleFeedback(press(333, 'cmd_status'))
        expect(seen.contexts).toHaveLength(0)
        expect(bot.answerCallbackQuery).toHaveBeenCalledWith(expect.any(String), { text: '🔒 Zugriff verweigert.' })
    })

    it('does not let a guest switch the global model via a sw_ button, but lets the owner', async () => {
        mu.roles.set('111', 'owner')
        mu.roles.set('222', 'guest')
        const { instance } = adapter([])
        const state = (globalThis as any).__novaState
        await (instance as any).handleFeedback(press(222, 'sw_openai_gpt-x', -500, 'group'))
        expect(state.llm.switchModel).not.toHaveBeenCalled()
        await (instance as any).handleFeedback(press(111, 'sw_openai_gpt-x'))
        expect(state.llm.switchModel).toHaveBeenCalledWith('gpt-x', 'openai')
    })
})
