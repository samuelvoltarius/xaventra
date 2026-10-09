/**
 * 2.89.4 LIVE: echter Eingang (createDaemonMessageEntry → message pipeline).
 *
 * Live 09.10.2026: Tracking-Auftrag endete in „kein echtes Maus-Werkzeug …
 * entzieht sich jedem automatischen Zugriff“, obwohl Direktlink, Browser mit
 * Eingabe und Desktop-Computer-Use existieren. Der Owner darf diesen Satz nie
 * wieder lesen; der System-Prompt verlangt die Kette.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const FALSE_DENIAL = 'Das Suchfeld ist dynamisch. Ich habe kein echtes Maus-Werkzeug — die Seite entzieht sich jedem automatischen Zugriff.'

const fixtures = vi.hoisted(() => ({ agent: vi.fn() }))
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

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')

const state: any = {
    config: {}, startTime: Date.now(), tools: { execute: vi.fn() }, channels: {},
    llm: { modelId: 'chat-a', providerId: 'none', runtimeModelIdentity: async () => ({ model: 'chat-a' }), complete: vi.fn(async () => ({ content: 'unexpected model answer' })) },
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand: async () => null })

beforeAll(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })
beforeEach(() => {
    fixtures.agent.mockReset()
    fixtures.agent.mockResolvedValue({
        content: FALSE_DENIAL,
        toolsExecuted: [], sessionId: 's', toolExecutions: [],
        actionState: { requiresTool: false, kind: 'none', fulfilled: true },
    })
})

async function ask(content: string): Promise<string[]> {
    const replies: string[] = []
    await entry('Telegram', 'live-owner', content, async text => { replies.push(text) })
    return replies
}

describe('LIVE: Fähigkeiten prüfen vor „kann ich nicht“ (echter Eingang)', () => {
    it('the false “kein Maus-Werkzeug / entzieht sich” claim never reaches the owner', async () => {
        const replies = await ask('Kannst du das DHL-Paket TEST19202000001 tracken?')
        const text = replies.join('\n')
        expect(text).not.toMatch(/Maus-Werkzeug/i)
        expect(text).not.toMatch(/entzieht sich jedem automatischen Zugriff/i)
        expect(text).toContain('Korrektur')
        expect(text).toContain('Direktlink')
        expect(text).toContain('Browser')
        expect(text).toContain('Desktop-Computer-Use')
    }, 120_000)

    it('the system prompt demands the escalation chain before any “kann ich not”', async () => {
        await ask('Tracke bitte TEST19202000001 über die DHL-Seite.')
        expect(fixtures.agent).toHaveBeenCalled()
        const options = fixtures.agent.mock.calls[0][0] as { systemPrompt?: string }
        expect(String(options.systemPrompt || '')).toContain('Eskalationskette')
        expect(String(options.systemPrompt || '')).toContain('browser_type')
        expect(String(options.systemPrompt || '')).toContain('desktop_input')
        expect(String(options.systemPrompt || '')).toMatch(/NIE „kein Maus-Werkzeug“/)
    }, 120_000)
})
