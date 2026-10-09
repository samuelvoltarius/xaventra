/**
 * 2.89.4 LIVE: echter Eingang (createDaemonMessageEntry → message pipeline).
 *
 * Empfehlungen zu „aktuell / neueste / Stand der Technik / Ende <Jahr>“ werden
 * mit Websuche, Systemdatum und Hardware je Knoten beantwortet. Ohne Treffer
 * ehrlich „mein Wissen kann veraltet sein“. Kein Großmodell auf purem CPU.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
    agent: vi.fn(),
    search: vi.fn(),
    strengths: [] as any[],
    permission: 'owner', group: false,
}))
vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...await importOriginal<typeof import('../users/multi-user-middleware.js')>(),
    initMultiUser: () => undefined,
    checkAuth: () => ({ allowed: true, permission: fixtures.permission, isNewUser: false, user: {} }),
    getUserPermission: () => fixtures.permission,
    isGroupChat: () => fixtures.group, shouldCoalesce: () => false,
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
vi.mock('../learning/capability-learning.js', async importOriginal => ({
    ...await importOriginal<typeof import('../learning/capability-learning.js')>(),
    capabilityGate: async () => null, capabilityReplyGate: async (_r: string, reply: string) => reply, capabilityHonestyPrompt: () => '',
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: () => '' }))
vi.mock('./approval-card-sources.js', async importOriginal => ({ ...await importOriginal<typeof import('./approval-card-sources.js')>(), startApprovalCardLoop: () => undefined }))
vi.mock('../install/software-freshness.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../install/software-freshness.js')>()
    return {
        ...actual,
        createGovernedWebSearch: () => ({ search: fixtures.search }),
    }
})
vi.mock('../mesh/node-strengths.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../mesh/node-strengths.js')>()
    return {
        ...actual,
        collectNodeStrengths: async () => fixtures.strengths,
    }
})

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')

const state: any = {
    config: {}, startTime: Date.now(), tools: { execute: vi.fn() }, channels: {},
    llm: { modelId: 'chat-a', providerId: 'none', runtimeModelIdentity: async () => ({ model: 'chat-a' }), complete: vi.fn(async () => ({ content: 'unexpected model answer' })) },
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand: async () => null })

async function ask(content: string): Promise<string[]> {
    const replies: string[] = []
    await entry('Telegram', 'live-owner', content, async text => { replies.push(text) })
    return replies
}

const cpuNode = {
    nodeId: 'cpu-box', local: true, online: true, skills: [], services: [],
    ramGB: 64, cpus: 16, modelMemoryGB: 64, modelMemoryHow: 'RAM',
    gpu: { name: null, backend: 'cpu', vramGB: undefined, unified: false, viaVllm: false },
}

beforeAll(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })

beforeEach(() => {
    fixtures.permission = 'owner'; fixtures.group = false
    fixtures.agent.mockReset()
    fixtures.agent.mockResolvedValue({ content: 'unexpected model answer', toolsExecuted: [], sessionId: 's', toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: false } })
    fixtures.search.mockReset()
    fixtures.strengths.length = 0
    fixtures.strengths.push(cpuNode)
    vi.unstubAllEnvs()
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
})

describe('2.89.4: Empfehlungs-Fragen am echten Eingang', () => {
    it.each(['guest', 'user', 'admin', 'owner-group'])('denies private recommendations for %s', async role => {
        fixtures.permission = role === 'owner-group' ? 'owner' : role
        fixtures.group = role === 'owner-group'
        const text = (await ask('Welche Modelle sind Ende 2026 aktuell?')).join('\n')
        expect(text).toMatch(/Owner|Direktchat/)
        expect(fixtures.search).not.toHaveBeenCalled()
        expect(fixtures.agent).not.toHaveBeenCalled()
    })
    it('„Ende 2026 aktuell“: Websuche-Beleg, Systemdatum, CPU ohne Großmodell — ohne Modellaufruf', async () => {
        fixtures.search.mockResolvedValue({
            tool: 'browser_search',
            hits: [{ url: 'https://ollama.com/library/gemma3', title: 'gemma3', snippet: 'Released 2025-03' }],
        })
        const text = (await ask('Welche Modelle sind Ende 2026 aktuell?')).join('\n')
        expect(text).toMatch(/Stand: \d{4}-\d{2}-\d{2} \(Systemzeit\)/)
        expect(text).toMatch(/geprüft mit browser_search/)
        expect(text).toContain('nur CPU')
        expect(text).toContain('keine großen Modelle')
        expect(text).not.toMatch(/:(?:30b|32b|70b|72b)\b/)
        expect(fixtures.agent).not.toHaveBeenCalled()
        expect(fixtures.search).toHaveBeenCalled()
    }, 60_000)

    it('ohne Suchergebnis: ehrlich „mein Wissen kann veraltet sein“, nie „Katalog aktuell“', async () => {
        fixtures.search.mockResolvedValue({ tool: 'web_search', hits: [] })
        const text = (await ask('Was ist Stand der Technik bei den Modellen?')).join('\n')
        expect(text).toContain('mein Wissen kann veraltet sein')
        expect(text).toMatch(/Stand: \d{4}-\d{2}-\d{2} \(Systemzeit\)/)
        expect(text).not.toMatch(/Katalog:\s*aktuell/)
        expect(text).not.toMatch(/geprüft mit/)
        expect(fixtures.agent).not.toHaveBeenCalled()
    }, 60_000)

    it('Inventar-Frage bleibt Inventar (kein Such-Pfad, kein Stale-Satz)', async () => {
        const text = (await ask('Welche Modelle hast du verfügbar?')).join('\n')
        expect(fixtures.search).not.toHaveBeenCalled()
        expect(text).not.toContain('mein Wissen kann veraltet sein')
    }, 60_000)
})
