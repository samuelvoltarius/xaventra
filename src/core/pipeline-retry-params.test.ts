import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2.89 Punkt 5: the pipeline retries (empty answer, announce-without-act) ran
// the agent again WITHOUT room, bot, pinned model, denied tools and workspace,
// and with loadSoul()/state.llm instead of the real prompt and model. Driven
// through the real handleMessage with a desktop room; only the agent is scripted.

const fixtures = vi.hoisted(() => ({ agent: vi.fn() }))
vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: () => ({ allowed: true, permission: 'owner', isNewUser: false, user: {} }),
    getUserPermission: () => 'owner',
    isGroupChat: () => false, shouldCoalesce: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
}))
vi.mock('./soul.js', () => ({
    soulExists: () => true, buildSystemPromptFromSoul: () => 'Fixture identity',
    loadSoul: () => ({}),
    getOnboardingMessage: () => '', isOnboardingResponse: () => false,
    parseOnboardingResponse: () => ({}), saveSoul: () => undefined, getOnboardingConfirmation: () => '',
}))
vi.mock('../agents/nova-runner.js', () => ({ runNovaAgent: fixtures.agent, clearSession: () => undefined }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../tools/skill-builder.js', () => ({ noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../desktop/bot-profile-store.js', () => ({
    getBotProfileStore: () => ({
        get: () => ({ id: 'bot-289', name: 'Werkstatt', handle: 'werkstatt', instructions: 'Hilf in der Werkstatt.', source: 'builtin',
            enabled: true, deniedTools: ['run_command'], modelPolicy: { mode: 'pinned', model: 'fixture-model', provider: 'fixture' } }),
    }),
}))

const { handleMessage } = await import('./message-pipeline.js')
const { runWithDesktopAgentContext } = await import('../desktop/desktop-agent-context.js')

beforeEach(() => { vi.clearAllMocks(); (globalThis as any).__novaLastMsg = {} })

async function runInRoom(content: string) {
    const replies: string[] = []
    const llm = { modelId: 'alias', providerId: 'local', runtimeModelIdentity: async () => ({ model: 'fixture/Model' }), complete: vi.fn(async () => ({ content: 'fallback' })) }
    const state: any = { config: {}, llm, tools: { execute: vi.fn(), getAll: () => [] }, channels: {}, startTime: Date.now() }
    await runWithDesktopAgentContext({
        principalId: 'owner-289', clientId: 'client-289', authorizationUserId: 'desktop:owner-289', roomId: 'room-289', botId: 'bot-289',
        preferredNodeIds: ['node-a'], modelMode: 'auto', workspaceId: 'ws-289',
    }, () => handleMessage('desktop', 'desktop:owner-289', content, async text => { replies.push(text) }, state, async () => ''))
    return { replies }
}

const scoped = {
    conversationId: 'room-289', botId: 'bot-289', workspaceId: 'ws-289', deniedTools: ['run_command'],
    modelOverride: { model: 'fixture-model', provider: 'fixture' }, preferredNodeIds: ['node-a'],
}

describe('pipeline retries keep the run parameters (live path, desktop room)', () => {
    it('announce-without-act retry: same room/bot/model/denied/workspace, real prompt + PFLICHT, same model client', async () => {
        fixtures.agent
            .mockResolvedValueOnce({ content: 'Klar, check ich:', toolsExecuted: [], toolExecutions: [], sessionId: 's' })
            .mockResolvedValueOnce({ content: 'Inhalt der Datei: 42', toolsExecuted: ['read_file'], sessionId: 's',
                toolExecutions: [{ toolName: 'read_file', success: true, result: '42' }] })
        await runInRoom('Lies die Datei /tmp/zahl.txt')
        expect(fixtures.agent).toHaveBeenCalledTimes(2)
        const [first, retry] = fixtures.agent.mock.calls.map(call => call[0])
        expect(first).toMatchObject(scoped)
        expect(retry).toMatchObject(scoped)
        expect(retry.llm).toBe(first.llm)
        expect(retry.systemPrompt.startsWith(first.systemPrompt)).toBe(true)
        expect(retry.systemPrompt).toContain('PFLICHT')
        expect(first.systemPrompt).toContain('BOT-PROFIL')
        // 2.89: the owner on the normal Main (no NOVA_OS_MODE) gets the plain-language rules.
        expect(process.env.NOVA_OS_MODE).toBeUndefined()
        expect(first.systemPrompt).toContain('BEDIENMODUS: STANDARD')
        expect(first.systemPrompt).toContain('Hoere nie mit einer Ankuendigung auf')
    }, 20_000)

    it('empty-answer retry: same parameters and the real system prompt (not loadSoul())', async () => {
        fixtures.agent
            .mockResolvedValueOnce({ content: '', toolsExecuted: [], toolExecutions: [], sessionId: 's' })
            .mockResolvedValueOnce({ content: 'Hallo, ich bin da.', toolsExecuted: [], toolExecutions: [], sessionId: 's' })
        await runInRoom('Erzähl mir einen kurzen Witz')
        expect(fixtures.agent.mock.calls.length).toBeGreaterThanOrEqual(2)
        const [first, retry] = fixtures.agent.mock.calls.map(call => call[0])
        expect(retry).toMatchObject(scoped)
        expect(retry.systemPrompt).toBe(first.systemPrompt)
        expect(retry.llm).toBe(first.llm)
    }, 20_000)
})
