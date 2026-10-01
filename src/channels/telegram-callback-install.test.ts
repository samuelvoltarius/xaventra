import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hotfix 2.80.1 (Befund 4) + P9 „ein Knopf-Rahmen“: approvals run only through
// Knopf-Karten (`ac:`). The old self-acting callbacks `patch_ok/no`,
// `skill_ok/no` and `ni:` run nothing for anyone (owner included) and point to
// a fresh card.

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
const patchGate = vi.hoisted(() => ({ approveEvolutionProposal: vi.fn(), getPatchProposals: vi.fn(() => [{ id: 'p1', status: 'queued' }]), applyApprovedDoctorProposal: vi.fn() }))
vi.mock('../synthesis/self-evolution.js', () => ({ approveEvolutionProposal: patchGate.approveEvolutionProposal, getPatchProposals: patchGate.getPatchProposals }))
vi.mock('../doctor/safe-fixes.js', () => ({ applyApprovedDoctorProposal: patchGate.applyApprovedDoctorProposal }))

import { TelegramAdapter, retiredApprovalHint } from './telegram.js'

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

describe('P9: retired approval callbacks run nothing and ask for a fresh card', () => {
    it.each([
        'patch_ok:p1', 'patch_no:p1', 'skill_ok:sp1', 'skill_no:sp1', 'ni:llama3.2:local', 'ni:qwen2.5-coder:7b:local', 'ni:x;id:local',
    ])('%s pressed by the owner: nothing applied, installed or released', async (data) => {
        process.env.NOVA_PATCH_GATE_TOKEN = 'fixture-gate'
        try {
            const { instance, bot } = adapter([])
            await (instance as any).handleFeedback(press(111, data))
            expect(patchGate.approveEvolutionProposal).not.toHaveBeenCalled()
            expect(patchGate.applyApprovedDoctorProposal).not.toHaveBeenCalled()
            expect(skills.updateSkillProposalStatus).not.toHaveBeenCalled()
            expect(cp.execFile).not.toHaveBeenCalled()
            expect(anyShell()).toBe(0)
            const answer = (bot.answerCallbackQuery.mock.calls as any[]).map(call => call[1]?.text).join(' ')
            expect(answer).toMatch(/Veralteter Knopf/)
            expect(answer).toMatch(/neue Karte/)
            expect(bot.editMessageReplyMarkup).toHaveBeenCalled()
        } finally { delete process.env.NOVA_PATCH_GATE_TOKEN }
    })

    it('also a non-owner in a group gets only the hint', async () => {
        const { instance } = adapter([])
        await (instance as any).handleFeedback(press(222, 'skill_ok:sp1', -500, 'group'))
        await (instance as any).handleFeedback(press(222, 'patch_ok:p1', -500, 'group'))
        expect(skills.updateSkillProposalStatus).not.toHaveBeenCalled()
        expect(patchGate.approveEvolutionProposal).not.toHaveBeenCalled()
    })

    it('recognises exactly the retired prefixes', () => {
        expect(retiredApprovalHint('patch_ok:x')).toMatch(/\/patch approve/)
        expect(retiredApprovalHint('ac:0123456789abcdef')).toBeNull()
        expect(retiredApprovalHint('cmd_status')).toBeNull()
        expect(retiredApprovalHint('nix')).toBeNull()
    })
})
