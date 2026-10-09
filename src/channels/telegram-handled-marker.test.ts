import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.89.4 (live): `/ai` showed the line „HANDLED“. Telegram button callbacks and
// the menu Status page forwarded the internal COMMAND_HANDLED marker as chat
// text (Markdown ate the underscores; the menu stripped them). Only real text
// is ever sent to a user.

const mu = vi.hoisted(() => ({
    roles: new Map<string, 'owner' | 'admin' | 'user' | 'guest' | 'blocked'>(),
    initMultiUser: vi.fn(),
    checkAuth: vi.fn((userId: string) => {
        const permission = mu.roles.get(userId) || 'guest'
        return { allowed: permission !== 'blocked', permission, isNewUser: false, user: { id: userId } }
    }),
}))
vi.mock('../users/multi-user-middleware.js', () => ({ initMultiUser: mu.initMultiUser, checkAuth: mu.checkAuth }))

const hc = vi.hoisted(() => ({
    calls: [] as any[][],
    /** Default: the command already answered via buttons. */
    impl: null as null | ((...args: any[]) => Promise<string | null>),
}))
vi.mock('../core/slash-commands.js', async importOriginal => {
    const actual = await importOriginal<any>()
    return {
        ...actual,
        handleCommand: vi.fn(async (...args: any[]) => {
            hc.calls.push(args)
            return hc.impl ? hc.impl(...args) : actual.COMMAND_HANDLED
        }),
    }
})
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'
import { COMMAND_HANDLED, commandReplyText } from '../core/slash-commands.js'

function adapter(allowFrom: string[] = []) {
    const instance = new TelegramAdapter({ token: 'fixture', allowFrom, verifyAuthority: async () => true })
    const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        answerCallbackQuery: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
        editMessageReplyMarkup: vi.fn(async () => true),
    }
    ;(instance as any).bot = bot
    return { instance, bot }
}

const press = (userId: number, data: string, chatId = userId, chatType = 'private') => ({
    id: `cb-${userId}-${data}`, data, from: { id: userId, username: `u${userId}` },
    message: { message_id: 7, chat: { id: chatId, type: chatType }, text: 'menu' },
})

const sentTexts = (bot: { sendMessage: any }) =>
    bot.sendMessage.mock.calls.map((call: any[]) => String(call[1] ?? ''))

const OWNER = 111
const principal = { channel: 'telegram', rawUserId: String(OWNER), principalId: String(OWNER), permission: 'owner' as const }

let pagesDir: string

beforeEach(() => {
    mu.roles.clear()
    hc.calls.length = 0
    hc.impl = null
    pagesDir = mkdtempSync(join(tmpdir(), 'tg-handled-'))
    ;(globalThis as any).__novaState = {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: { switchModel: vi.fn(async () => true) }, internalLlm: null, memory: null, learning: null,
        tools: null, resilience: null, startTime: Date.now(), config: {},
    }
    mu.roles.set(String(OWNER), 'owner')
})
afterEach(() => {
    delete (globalThis as any).__novaState
    rmSync(pagesDir, { recursive: true, force: true })
})

describe('commandReplyText hides the internal handled marker', () => {
    it('drops the marker and empty replies, keeps real text', () => {
        expect(COMMAND_HANDLED).toBe('__HANDLED__')
        expect(commandReplyText(COMMAND_HANDLED)).toBeNull()
        expect(commandReplyText('__HANDLED__')).toBeNull()
        expect(commandReplyText('')).toBeNull()
        expect(commandReplyText(null)).toBeNull()
        expect(commandReplyText(undefined)).toBeNull()
        expect(commandReplyText('Hallo')).toBe('Hallo')
        expect(commandReplyText('HANDLED')).toBe('HANDLED')
    })
})

describe('button callbacks never show the handled marker as a chat line', () => {
    it('/ai button: a silent command stays silent (live: the line „HANDLED“)', async () => {
        const { instance, bot } = adapter([String(OWNER)])
        await (instance as any).handleFeedback(press(OWNER, 'cmd_ai'))
        const texts = sentTexts(bot)
        expect(texts.join('\n')).not.toMatch(/HANDLED/i)
        expect(texts.join('\n')).not.toContain('__HANDLED__')
    })

    it('every cmd_/persona_/learn_/llm_ callback filters the marker', async () => {
        const { instance, bot } = adapter([String(OWNER)])
        for (const data of ['cmd_status', 'cmd_help', 'cmd_layers', 'persona_nova', 'learn_x', 'llm_list']) {
            await (instance as any).handleFeedback(press(OWNER, data))
        }
        const texts = sentTexts(bot)
        expect(texts.length).toBe(0)
        expect(texts.join('\n')).not.toMatch(/HANDLED/i)
    })

    it('real command text is still delivered', async () => {
        hc.impl = async () => 'ℹ️ /ai wurde zu /mesh zusammengeführt.'
        const { instance, bot } = adapter([String(OWNER)])
        await (instance as any).handleFeedback(press(OWNER, 'cmd_ai'))
        const texts = sentTexts(bot)
        expect(texts).toContain('ℹ️ /ai wurde zu /mesh zusammengeführt.')
    })
})

describe('menu Status page never turns the marker into „HANDLED“', () => {
    it('asks for the text (not the button path) and filters the marker', async () => {
        hc.impl = async (_cmd, _args, _from, _state, _llms, context) =>
            context?.channel === 'telegram' ? COMMAND_HANDLED : 'Mesh-Status: alle Knoten frisch'
        const { instance } = adapter([String(OWNER)])
        await (instance as any).registerMenuViews(String(OWNER), principal)
        const pages = await import('./telegram-pages.js')
        const view = await pages.runMenu('status', String(OWNER), { dataDir: pagesDir })
        expect(view.text).toContain('Mesh-Status: alle Knoten frisch')
        expect(view.text).not.toMatch(/HANDLED/i)
        // The menu must not take the Telegram button path (that one returns the marker).
        expect(hc.calls.at(-1)?.[5]).toMatchObject({ channel: 'menu', permission: 'owner' })
    })

    it('even a forced marker never becomes the line „HANDLED“', async () => {
        hc.impl = async () => COMMAND_HANDLED
        const { instance } = adapter([String(OWNER)])
        await (instance as any).registerMenuViews(String(OWNER), principal)
        const pages = await import('./telegram-pages.js')
        const view = await pages.runMenu('status', String(OWNER), { dataDir: pagesDir })
        expect(view.text).not.toMatch(/HANDLED/i)
        expect(view.text).toContain('Status gerade nicht verfügbar.')
    })
})
