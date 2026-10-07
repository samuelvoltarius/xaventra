/**
 * 2.89.1 — the first-run introduction must not swallow questions.
 *
 * Real entry (createDaemonMessageEntry → message pipeline), real soul module in a
 * sandbox without SOUL.md. Only the model (runNovaAgent) and the network probe are scripted.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ agent: vi.fn(), internet: true }))

vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: (from: string, channel: string) => ({ allowed: true, permission: 'owner', isNewUser: false, user: { id: from, channel, permissionSource: 'explicit' } }),
    getUserPermission: () => 'owner',
    getOrCreateUser: (from: string, channel: string) => ({ id: from, channel }),
    setUserPermission: () => true,
    isGroupChat: (chatId: string, userId: string) => chatId !== userId,
    trackGroupMessage: () => undefined,
    shouldCoalesce: () => false, isCoalescedMarker: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getOnboardingMessage: () => null, getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
}))
vi.mock('../agents/nova-runner.js', () => ({ runNovaAgent: fixtures.agent, clearSession: () => undefined }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../tools/skill-builder.js', async importOriginal => ({ ...(await importOriginal<any>()), noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test', completeTask: () => undefined, recordTokens: () => undefined }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../learning/capability-learning.js', () => ({
    capabilityGate: async () => ({ handled: false }),
    capabilityReplyGate: async (_request: string, reply: string) => reply,
    capabilityHonestyPrompt: () => '',
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: async () => '' }))
vi.mock('./environment.js', async importOriginal => ({ ...(await importOriginal<any>()), hasInternet: () => fixtures.internet }))

const sandbox = mkdtempSync(join(tmpdir(), 'onboarding-question-'))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')
const slash = await import('./slash-commands.js')
const soul = await import('./soul.js')

let state: any
const handleCommand = async (cmd: string, args: string, from: string, context?: any) => slash.handleCommand(cmd, args, from, state, [], context)
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand })
const agentResult = (content: string) => ({
    content, sessionId: 'fixture-session', toolsExecuted: [], toolExecutions: [],
    actionState: { requiresTool: false, kind: 'none', fulfilled: false },
})
async function send(from: string, content: string) {
    const replies: string[] = []
    await entry('desktop', from, content, async text => { replies.push(text) })
    return replies
}

beforeEach(() => {
    vi.clearAllMocks()
    fixtures.internet = true
    fixtures.agent.mockImplementation(async () => agentResult('Modellantwort.'))
    state = {
        config: {}, llm: { modelId: 'alias', providerId: 'local', complete: vi.fn(async () => ({ content: 'plain' })) },
        tools: { execute: vi.fn(), getAll: () => [], getStats: () => ({ total: 0 }) },
        channels: {}, startTime: Date.now(),
    }
    for (const key of Object.keys(globalThis as any)) if (key.startsWith('onboarding:')) delete (globalThis as any)[key]
})
afterAll(() => cwd.mockRestore())

describe('first start without SOUL: questions are not swallowed by the introduction', () => {
    it('„hast du Internet?“ is answered from the one internet check, no introduction, no onboarding state', async () => {
        expect(soul.soulExists()).toBe(false)
        const replies = await send('erst-1', 'hast du Internet?')
        expect(replies).toEqual(['Ja, ich habe Internet.'])
        expect(fixtures.agent).not.toHaveBeenCalled()
        expect(existsSync(join(sandbox, 'SOUL.md'))).toBe(false)
        fixtures.internet = false
        const offline = await send('erst-1', 'hast du Internet?')
        expect(offline[0]).toMatch(/kein Internet/)
    }, 30000)

    it('a question that needs the model also skips the introduction', async () => {
        const replies = await send('erst-2', 'kannst du mir helfen?')
        expect(replies).toEqual(['Modellantwort.'])
        expect(fixtures.agent).toHaveBeenCalledTimes(1)
    }, 30000)

    it('Gegenprobe: a plain greeting still starts the introduction, and „Du heißt Mia“ sets the name', async () => {
        const first = await send('erst-3', 'Hallo')
        expect(first).toHaveLength(1)
        expect(first[0]).toBe(soul.getOnboardingMessage())
        expect(soul.soulExists()).toBe(false)
        const named = await send('erst-3', 'Du heißt Mia')
        expect(named).toHaveLength(1)
        expect(named[0]).toContain('Mia')
        expect(soul.soulExists()).toBe(true)
    }, 30000)
})
