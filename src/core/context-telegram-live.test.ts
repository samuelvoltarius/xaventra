/**
 * 2.90.0 Kontext je Aufgabe über den echten Telegram-Eingang
 * (createDaemonMessageEntry → message pipeline → runner, Modell gemockt).
 * Prüft: Schattenbetrieb ändert den gesendeten Prompt nicht, misst aber;
 * `on` sendet den kleineren Aufgaben-Prompt; jede Messzeile trägt die
 * echte Modelleingabe aus dem Runner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ agent: vi.fn(), metrics: [] as any[] }))
vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...await importOriginal<typeof import('../users/multi-user-middleware.js')>(),
    initMultiUser: () => undefined,
    checkAuth: () => ({ allowed: true, permission: 'owner', isNewUser: false, user: {} }),
    getUserPermission: () => 'owner',
    isGroupChat: () => false, shouldCoalesce: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
}))
vi.mock('./soul.js', () => ({
    soulExists: () => true, buildSystemPromptFromSoul: () => 'Fixture identity', loadSoul: () => ({}),
    getOnboardingMessage: () => '', isOnboardingResponse: () => false, parseOnboardingResponse: () => ({}), saveSoul: () => undefined, getOnboardingConfirmation: () => '',
}))
vi.mock('../agents/nova-runner.js', () => ({
    runNovaAgent: fixtures.agent, clearSession: () => undefined,
    syncDeliveredTurn: () => undefined, toolDigestForHistory: () => '',
}))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../tools/skill-builder.js', async importOriginal => ({ ...await importOriginal<typeof import('../tools/skill-builder.js')>(), noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', async importOriginal => ({ ...await importOriginal<typeof import('../intelligence/roi-dashboard.js')>(), startTask: () => undefined, detectCategory: () => 'test', completeTask: () => undefined, recordTokens: () => undefined }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
// Gate vor dem Modell aus (das Modell liefert die falsche Behauptung); reply gate und
// honesty prompt bleiben REAL — genau die sollen greifen.
vi.mock('../learning/capability-learning.js', async importOriginal => ({
    ...await importOriginal<typeof import('../learning/capability-learning.js')>(),
    capabilityGate: async () => ({ handled: false }),
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: () => '' }))
vi.mock('./approval-card-sources.js', async importOriginal => ({ ...await importOriginal<typeof import('./approval-card-sources.js')>(), startApprovalCardLoop: () => undefined }))

vi.mock('./context-metrics.js', async importOriginal => {
    const real = await importOriginal<typeof import('./context-metrics.js')>()
    return { ...real, recordContextMetrics: (entry: any) => { fixtures.metrics.push(entry); return true } }
})

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')

const state: any = {
    config: {}, startTime: Date.now(), tools: { execute: vi.fn() }, channels: {},
    llm: { modelId: 'chat-a', providerId: 'none', runtimeModelIdentity: async () => ({ model: 'chat-a' }), complete: vi.fn(async () => ({ content: 'unexpected model answer' })) },
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand: async () => null })

const STATS = { modelInputChars: 31_000, systemChars: 14_000, historyChars: 9_000, toolSchemaChars: 8_000, toolsOffered: 9, modelCalls: 3, maxModelInputChars: 36_000, toolCalls: 2, selfInfoCalls: 0 }

beforeAll(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })
beforeEach(() => {
    fixtures.agent.mockReset()
    fixtures.metrics.length = 0
    fixtures.agent.mockResolvedValue({
        content: 'Die Steckdose ist jetzt an.',
        toolsExecuted: ['hass_turn_on'], sessionId: 's', toolExecutions: [],
        actionState: { requiresTool: false, kind: 'none', fulfilled: true },
        contextStats: STATS,
    })
})
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })

async function ask(content: string): Promise<{ prompt: string; metrics: any }> {
    await entry('Telegram', 'live-owner', content, async () => undefined)
    expect(fixtures.agent).toHaveBeenCalled()
    const prompt = String((fixtures.agent.mock.calls.at(-1)![0] as { systemPrompt?: string }).systemPrompt || '')
    return { prompt, metrics: fixtures.metrics.at(-1) }
}

describe('2.90.0 Kontext je Aufgabe über den Telegram-Eingang', () => {
    it('shadow (default): the old prompt is sent, the task prompt is only measured', async () => {
        const { prompt, metrics } = await ask('Schalte bitte die Steckdose vom Drucker ein')
        expect(metrics).toBeDefined()
        expect(metrics.channel.toLowerCase()).toBe('telegram')
        expect(metrics.taskPromptMode).toBe('shadow')
        expect(metrics.promptSentChars).toBe(prompt.length)
        expect(metrics.taskPromptChars).toBeGreaterThan(0)
        expect(metrics.taskPromptChars).toBeLessThanOrEqual(metrics.promptRawChars)
        expect(metrics.modelInputChars).toBe(STATS.modelInputChars)
        expect(metrics.toolCalls).toBe(2)
        expect(metrics.outcome).toBe('answer')
        expect(metrics.lagebildMode).toBe('shadow')
        expect(metrics).not.toHaveProperty('content')
    }, 120_000)

    it('on: the task prompt is sent; core and action rules stay', async () => {
        const shadow = await ask('Schalte bitte die Steckdose vom Drucker ein')
        vi.stubEnv('XAVENTRA_TASK_PROMPT', 'on')
        const on = await ask('Schalte bitte die Steckdose vom Drucker ein')
        expect(on.metrics.taskPromptMode).toBe('on')
        expect(on.prompt.length).toBeLessThan(shadow.prompt.length)
        expect(on.prompt).toContain('## HANDELN')
        expect(on.prompt).toMatch(/AKTUELLE SYSTEMZEIT/)
        expect(on.metrics.promptSentChars).toBe(on.prompt.length)
    }, 120_000)

    it('off: no task prompt is built at all', async () => {
        vi.stubEnv('XAVENTRA_TASK_PROMPT', 'off')
        const { metrics } = await ask('Schalte bitte die Steckdose vom Drucker ein')
        expect(metrics.taskPromptMode).toBeUndefined()
        expect(metrics.taskPromptChars).toBeUndefined()
    }, 120_000)
})

describe('2.90.0 Übergabe an einen benannten Knoten über den Telegram-Eingang (live 29.10. 14:00)', () => {
    it('„Gib diese Aufgabe an ns1: …“ tells the model to use spawn_subagent with the real node id and a bounded wait', async () => {
        const { setKnownNodeNamesForTests } = await import('../mesh/known-node-names.js')
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns1', hostname: 'ns1' }])
        try {
            const { prompt } = await ask('Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und wer ich bin.')
            expect(prompt).toContain('## ÜBERGABE AN KNOTEN')
            expect(prompt).toContain('spawn_subagent mit mesh_node="xaventra-ns1"')
            expect(prompt).toMatch(/timeout_seconds=\d+/)
            const block = prompt.slice(prompt.indexOf('## ÜBERGABE AN KNOTEN')).split('\n\n## ')[0]
            expect(block).not.toContain('mesh_delegate')
            const status = await ask('wie geht es ns1?')
            expect(status.prompt).not.toContain('## ÜBERGABE AN KNOTEN')
        } finally { setKnownNodeNamesForTests(null) }
    }, 120_000)
})

describe('2.91.0 Themen-Fäden über den Telegram-Eingang (Schattenbetrieb)', () => {
    it('the battery question is assigned to Auto, the run carries the thread, the prompt stays the same', async () => {
        const { currentThreadId } = await import('./topic-threads.js')
        let seen: string | undefined = 'unset'
        fixtures.agent.mockImplementationOnce(async () => {
            seen = currentThreadId()
            return { content: 'Der Akku steht bei 80 %.', toolsExecuted: [], sessionId: 's', toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: true }, contextStats: STATS }
        })
        vi.stubEnv('XAVENTRA_THREADS', 'off')
        const before = await ask('Wie voll ist der Akku vom Dolphin?')
        vi.stubEnv('XAVENTRA_THREADS', 'shadow')
        fixtures.agent.mockImplementationOnce(async () => {
            seen = currentThreadId()
            return { content: 'Der Akku steht bei 80 %.', toolsExecuted: [], sessionId: 's', toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: true }, contextStats: STATS }
        })
        const { prompt, metrics } = await ask('Wie voll ist der Akku vom Dolphin?')
        expect(metrics.threadMode).toBe('shadow')
        expect(metrics.threadKey).toBe('auto')
        expect(metrics.threadRule).toBe('marke')
        expect(seen).toBe('thread:auto')
        expect(prompt.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')).toBe(before.prompt.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ''))
    }, 120_000)
})

describe('Ein Weg: ein Verlauf für Telegram und markierte Räume (echter Eingang)', () => {
    const inRoom = async (ownerHistory: boolean) => {
        const { runWithDesktopAgentContext } = await import('../desktop/desktop-agent-context.js')
        await runWithDesktopAgentContext({
            principalId: 'live-owner', clientId: 'test', authorizationUserId: 'desktop:live-owner', roomId: 'room-a', botId: 'nova',
            ownerHistory, preferredNodeIds: [], modelMode: 'auto',
        }, () => entry('desktop', 'desktop:live-owner', 'Wie voll ist der Akku vom Dolphin?', async () => undefined))
        expect(fixtures.agent).toHaveBeenCalled()
        return { run: fixtures.agent.mock.calls.at(-1)![0] as { conversationId?: string }, metrics: fixtures.metrics.at(-1) }
    }
    it('a marked room runs in the owner history and through the threads', async () => {
        const { run, metrics } = await inRoom(true)
        expect(run.conversationId).toBeUndefined()
        expect(metrics.historyScope).toBe('owner')
        expect(metrics.threadKey).toBe('auto')
    }, 120_000)
    it('Gegenprobe: a room without the mark keeps its own history and stays outside the threads', async () => {
        const { run, metrics } = await inRoom(false)
        expect(run.conversationId).toBe('room-a')
        expect(metrics.historyScope).toBe('raum')
        expect(metrics.threadRule).toBe('raum')
    }, 120_000)
})
