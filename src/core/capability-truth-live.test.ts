import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURE_CONFIG, FIXTURE_GRAPH, fixtureRegistryRows, fixtureScoutNodes } from '../test-utils/capability-truth-fixture.js'

// 2.89 Paket C, LIVE path: the real daemon entry (createDaemonMessageEntry) in front of the real
// message pipeline. The same fixture as capability-truth.test.ts must come out of the reply the
// owner actually reads - not only out of the functions called directly ("green in test, dead in
// production": 2.88.3 found that exactly the entry's execution object switched whole stages off).

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
vi.mock('../agents/nova-runner.js', () => ({ runNovaAgent: fixtures.agent, clearSession: () => undefined }))
vi.mock('../llm/response-cache.js', () => ({ getCachedResponse: () => null, cacheResponse: vi.fn() }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../tools/skill-builder.js', async importOriginal => ({ ...await importOriginal<typeof import('../tools/skill-builder.js')>(), noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', async importOriginal => ({ ...await importOriginal<typeof import('../intelligence/roi-dashboard.js')>(), startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../install/software-scout.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../install/software-scout.js')>()
    return { ...actual, collectScoutNodes: async () => fixtureScoutNodes((await import('../mesh/mesh-registry.js')).getLocalNodeId()) }
})
vi.mock('../mesh/capability-graph.js', async importOriginal => ({
    ...await importOriginal<typeof import('../mesh/capability-graph.js')>(),
    getCapabilityGraph: () => ({ getSnapshot: () => structuredClone(FIXTURE_GRAPH), pruneStale: () => structuredClone(FIXTURE_GRAPH) }),
}))
// Side effects are off in tests, which also switches the learning gate off. The gate is given its real
// default ports (inventory included) here, exactly as production runs it; only the card port is inert.
vi.mock('../learning/capability-learning.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../learning/capability-learning.js')>()
    return {
        ...actual,
        capabilityGate: (text: string, ctx: any) => actual.handleCapabilityRequest(text, ctx, { ...actual.defaultLearnDeps(), offerCard: () => ({ ok: false }) }),
    }
})

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')

const state: any = {
    config: FIXTURE_CONFIG, startTime: Date.now(), tools: { execute: vi.fn() }, channels: {},
    llm: { modelId: 'chat-a', providerId: 'vllm', runtimeModelIdentity: async () => ({ model: 'chat-a-full' }), complete: vi.fn(async () => ({ content: 'unexpected' })) },
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand: async () => null })

async function ask(content: string): Promise<string[]> {
    const replies: string[] = []
    await entry('Telegram', 'live-owner', content, async text => { replies.push(text) })
    return replies
}

beforeAll(async () => {
    const { saveMeshData } = await import('../mesh/mesh-registry.js')
    saveMeshData({ nodes: fixtureRegistryRows() as any, tasks: [] })
    const { getToolRegistry } = await import('../tools/complete-registry.js')
    // A Gmail tool is registered, but nothing is connected.
    getToolRegistry().register({ name: 'gmail_search', description: 'Mails suchen', category: 'system', parameters: [], handler: async () => 'x' } as any)
}, 180_000)
beforeEach(async () => {
    fixtures.agent.mockReset()
    fixtures.agent.mockResolvedValue({ content: 'Antwort vom Modell', toolsExecuted: [], sessionId: 's', toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: false } })
    vi.stubGlobal('fetch', vi.fn(async (url: any) => String(url).endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [{ id: 'chat-a' }] }), { status: 200 })
        : Promise.reject(new TypeError('fetch failed'))))
    ;(globalThis as any).__novaLastMsg = {}
    const { resetNodeStrengthMemo } = await import('../mesh/node-strengths.js')
    resetNodeStrengthMemo()
})

describe('live: real daemon entry -> real pipeline', () => {
    it('the mesh question lists the nodes of the one node view (registry node online, stale registry node offline)', async () => {
        const replies = await ask('Mesh')
        const text = replies.join('\n')
        expect(text).toContain('gpu-box')
        expect(text).toMatch(/registry-pi[^\n]*online/)
        expect(text).toMatch(/old-box[^\n]*offline/)
        expect(fixtures.agent).not.toHaveBeenCalled()
    }, 180_000)

    it('the model question names the one active runtime and whether it answers', async () => {
        const text = (await ask('Welches Modell nutzt du gerade?')).join('\n')
        expect(text).toContain('vllm/chat-a')
        expect(text).toContain('läuft lokal und antwortet')
        expect(fixtures.agent).not.toHaveBeenCalled()
    }, 180_000)

    it('Whisper on another node is "kann": the gate does not say "kann ich nicht"', async () => {
        const replies = await ask('Kannst du meine Sprachnachricht abschreiben?')
        expect(replies.join('\n')).not.toContain('kann ich noch nicht')
        expect(fixtures.agent).toHaveBeenCalled()
    }, 180_000)

    it('a registered Gmail tool without a connection answers "Verbindung steht noch nicht" (not "soll ich es lernen")', async () => {
        const replies = await ask('Kannst du meine Mails lesen?')
        const text = replies.join('\n')
        expect(text).toContain('Verbindung zu Gmail')
        expect(text).not.toContain('Soll ich es lernen')
        expect(fixtures.agent).not.toHaveBeenCalled()
    }, 180_000)
})
