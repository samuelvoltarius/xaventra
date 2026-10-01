import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hotfix 2.80.1 (Befund 4): callbacks that install or approve something are
// owner-only, the model name is allowlisted and nothing runs through a shell.

const mu = vi.hoisted(() => ({
    roles: new Map<string, 'owner' | 'admin' | 'user' | 'guest' | 'blocked'>(),
    initMultiUser: vi.fn(),
    checkAuth: vi.fn((userId: string) => {
        const permission = mu.roles.get(userId) || 'guest'
        return { allowed: permission !== 'blocked', permission, isNewUser: false, user: { id: userId } }
    }),
    getUserPermission: vi.fn((userId: string) => mu.roles.get(userId) || 'guest'),
}))
vi.mock('../users/multi-user-middleware.js', () => ({ initMultiUser: mu.initMultiUser, checkAuth: mu.checkAuth, getUserPermission: mu.getUserPermission }))

const cp = vi.hoisted(() => ({
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, 'success', '')
        return {} as any
    }),
    execSync: vi.fn(() => ''),
    exec: vi.fn(),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), execFile: cp.execFile, execSync: cp.execSync, exec: cp.exec }))
vi.mock('child_process', async importOriginal => ({ ...(await importOriginal<any>()), execFile: cp.execFile, execSync: cp.execSync, exec: cp.exec }))

const skills = vi.hoisted(() => ({
    getSkillProposals: vi.fn(() => [{ id: 'sp1', name: 'demo', status: 'proposed', ownerId: '111' }]),
    updateSkillProposalStatus: vi.fn(() => ({ id: 'sp1', name: 'demo' })),
}))
vi.mock('../tools/skill-builder.js', () => skills)
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter, parseNodeInstallCallback } from './telegram.js'

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
    id: `cb-${userId}`, data, from: { id: userId, username: `u${userId}` },
    message: { message_id: 7, chat: { id: chatId, type: chatType }, text: 'menu' },
})

const anyShell = () => cp.execSync.mock.calls.length + cp.exec.mock.calls.length

beforeEach(() => {
    mu.roles.clear()
    mu.roles.set('111', 'owner')
    mu.roles.set('222', 'user')
    cp.execFile.mockClear(); cp.execSync.mockClear(); cp.exec.mockClear()
    skills.updateSkillProposalStatus.mockClear()
    ;(globalThis as any).__novaState = { running: true, config: {} }
})
afterEach(() => { delete (globalThis as any).__novaState })

describe('ni: node-install callback (Hotfix 2.80.1, Befund 4)', () => {
    it('rejects a non-owner and executes nothing', async () => {
        const { instance, bot } = adapter([])
        await (instance as any).handleFeedback(press(222, 'ni:llama3.2:local', -500, 'group'))
        expect(cp.execFile).not.toHaveBeenCalled()
        expect(anyShell()).toBe(0)
        expect(bot.answerCallbackQuery.mock.calls.some((call: any[]) => String(call[1]?.text).includes('🔒'))).toBe(true)
    })

    it('rejects an owner callback with shell metacharacters in the model and executes nothing', async () => {
        const { instance } = adapter([])
        await (instance as any).handleFeedback(press(111, 'ni:x;id:local'))
        await (instance as any).handleFeedback(press(111, 'ni:x$(id):local'))
        await (instance as any).handleFeedback(press(111, 'ni:x id:local'))
        expect(cp.execFile).not.toHaveBeenCalled()
        expect(anyShell()).toBe(0)
    })

    it('refuses remote installation instead of ssh-ing to the node', async () => {
        const { instance, bot } = adapter([])
        await (instance as any).handleFeedback(press(111, 'ni:llama3.2:xaventra-ns2'))
        expect(cp.execFile).not.toHaveBeenCalled()
        expect(anyShell()).toBe(0)
        const texts = bot.sendMessage.mock.calls.map((call: any[]) => String(call[1]))
        expect(texts.some(text => /Mesh/.test(text))).toBe(true)
    })

    it('runs a valid owner callback as execFile without a shell, with the exact argument array', async () => {
        const { instance } = adapter([])
        await (instance as any).handleFeedback(press(111, 'ni:qwen2.5-coder:7b:local'))
        expect(cp.execFile).toHaveBeenCalledTimes(1)
        const [file, args, options] = cp.execFile.mock.calls[0] as any[]
        expect(file).toBe('ollama')
        expect(args).toEqual(['pull', 'qwen2.5-coder:7b'])
        expect(options?.shell).not.toBe(true)
        expect(anyShell()).toBe(0)
    })

    it('parses strictly: allowlisted model, node required to be a plain name', () => {
        expect(parseNodeInstallCallback('ni:llama3.2:local')).toEqual({ model: 'llama3.2', node: 'local' })
        expect(parseNodeInstallCallback('ni:hf.co/org/model:q4:local')).toEqual({ model: 'hf.co/org/model:q4', node: 'local' })
        expect(parseNodeInstallCallback('ni:x;id:local')).toBeNull()
        expect(parseNodeInstallCallback('ni:-rf:local')).toBeNull()
        expect(parseNodeInstallCallback('ni:llama:lo cal')).toBeNull()
        expect(parseNodeInstallCallback('ni:')).toBeNull()
    })
})

describe('skill_ok / skill_no callbacks are owner-only (Hotfix 2.80.1)', () => {
    it('does not let a non-owner release a skill to the sandbox', async () => {
        const { instance } = adapter([])
        await (instance as any).handleFeedback(press(222, 'skill_ok:sp1', -500, 'group'))
        await (instance as any).handleFeedback(press(222, 'skill_no:sp1', -500, 'group'))
        expect(skills.updateSkillProposalStatus).not.toHaveBeenCalled()
    })

    it('lets the owner release it', async () => {
        const { instance } = adapter([])
        await (instance as any).handleFeedback(press(111, 'skill_ok:sp1'))
        expect(skills.updateSkillProposalStatus).toHaveBeenCalledWith('sp1', 'approved', '111')
    })
})
