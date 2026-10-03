import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({ agent: vi.fn(), cache: vi.fn(), capture: vi.fn(), photo: vi.fn(), permission: 'user' }))
vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: () => ({ allowed: true, permission: fixtures.permission, isNewUser: false, user: {} }),
    getUserPermission: () => fixtures.permission,
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
vi.mock('../llm/response-cache.js', () => ({ getCachedResponse: fixtures.cache, cacheResponse: vi.fn() }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: async () => ({ honest: false, issues: ['fixture synthesis failure'] }) }))
vi.mock('../tools/skill-builder.js', () => ({ noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))

const { handleMessage } = await import('./message-pipeline.js')

beforeEach(() => {
    vi.clearAllMocks()
    fixtures.permission = 'user'
    ;(globalThis as any).__novaLastMsg = {}
    fixtures.cache.mockReturnValue('STALE CACHED ANSWER')
    fixtures.agent.mockResolvedValue({
        content: 'Im Werkzeugkatalog stehen verfügbare Funktionen.',
        toolsExecuted: ['nova_capabilities'], sessionId: 'fixture-session',
        toolExecutions: [{ toolName: 'nova_capabilities', success: true, result: 'RAW CATALOG' }],
        actionState: { requiresTool: false, kind: 'none', fulfilled: false },
    })
})

async function run(content: string) {
    const replies: string[] = []
    const identity = vi.fn(async () => ({ model: 'fixture/Measured-Model' }))
    const state: any = {
        config: {}, llm: { modelId: 'alias', providerId: 'local', runtimeModelIdentity: identity },
        tools: { execute: fixtures.capture }, channels: { telegram: { sendPhoto: fixtures.photo } }, startTime: Date.now(),
    }
    await handleMessage('Telegram', 'test-flow-user', content, async text => { replies.push(text) }, state, async () => '')
    return { replies, identity }
}

describe('actual message pipeline with scripted agent, no network or capture', () => {
    it('answers the owner LAN question from background facts despite invented control claims and failed fact-check', async () => {
        fixtures.permission = 'owner'
        const { getNovaDataDir } = await import('./data-root.js')
        const { recordDiscoveryObservation } = await import('../sensing/awareness.js')
        const { recordCandidates } = await import('../sensing/device-registry.js')
        recordDiscoveryObservation(getNovaDataDir(), { scannedHosts: 154, probes: 1297, timedOut: true, truncated: true } as any)
        recordCandidates(getNovaDataDir(), [{ type: 'homeassistant', host: '192.168.1.42', port: 8123, via: 'mdns' }])
        fixtures.agent.mockResolvedValue({ content: 'Alle Geräte voll steuerbar. Screenshots von jedem Node. Kein Internet.', sessionId: 'fixture-session', toolsExecuted: ['blue_asset_inventory'],
            toolExecutions: [{ toolName: 'blue_asset_inventory', success: true, result: 'fixture-node online' }],
            actionState: { requiresTool: true, kind: 'system', fulfilled: true } })
        const { replies } = await run('welche geräte findest du im netzwerk? die du verwalten und sterun könntest?')
        expect(replies.at(-1)).toContain('Home Assistant')
        expect(replies.at(-1)).toContain('Teilsuche')
        expect(replies.at(-1)).toContain('fixture-node online')
        expect(replies.at(-1)).not.toContain('voll steuerbar')
        expect(replies.at(-1)).not.toContain('Kein Internet')
        expect(fixtures.cache).not.toHaveBeenCalled()
    }, 15000)
    it('retains verified node capabilities alongside the capture limitation after fact-check fallback', async () => {
        fixtures.agent.mockResolvedValue({ content: 'Alle Bilder gesendet.', sessionId: 'fixture-session', toolsExecuted: ['mesh_nodes', 'nova_capabilities'],
            toolExecutions: [
                { toolName: 'mesh_nodes', success: true, result: 'fixture-node: online; LLM und STT verfügbar' },
                { toolName: 'nova_capabilities', success: true, result: 'RAW CATALOG' },
            ], actionState: { requiresTool: true, kind: 'screenshot', fulfilled: false } })
        const { replies } = await run('was können deine nodes? send mir einen screnn shot vbon jeden')
        expect(replies.at(-1)).toContain('fixture-node: online; LLM und STT verfügbar')
        expect(replies.at(-1)).toContain('keine Bilddatei übertragen')
        expect(replies.at(-1)).not.toContain('RAW CATALOG')
        expect(replies.at(-1)).not.toContain('Alle Bilder gesendet')
        expect(fixtures.capture).not.toHaveBeenCalled()
        expect(fixtures.photo).not.toHaveBeenCalled()
    }, 15000)
    it('retains actual per-node delivery after partial capture, not model all-images claims', async () => {
        fixtures.permission = 'owner'
        fixtures.agent.mockResolvedValue({ content: 'Alle Bilder gesendet.', sessionId: 'fixture-session', toolsExecuted: ['mesh_screenshot'],
            toolExecutions: [{ toolName: 'mesh_screenshot', success: false, result: { captures: [
                { nodeId: 'spark', captured: true, delivered: true }, { nodeId: 'nas', captured: false, delivered: false, error: 'No enrolled graphical adapter' },
            ] } }], actionState: { requiresTool: true, kind: 'screenshot', fulfilled: false } })
        const { replies } = await run('send mir einen Screenshot von allen nodes')
        expect(replies.at(-1)).toContain('spark: Bild aufgenommen; Bildzustellung bestätigt')
        expect(replies.at(-1)).toContain('nas: kein Bild aufgenommen; keine Bildzustellung bestätigt')
        expect(replies.at(-1)).not.toContain('Alle Bilder gesendet')
        expect(fixtures.capture).not.toHaveBeenCalled()
    }, 15000)

    it('passes measured identity and the complete mixed question to the agent without a cached answer', async () => {
        const question = 'Welches Model nutzt du gerade ? Und warum willst auf auf na1 ein llm. ?'
        const { identity } = await run(question)
        expect(identity).toHaveBeenCalledOnce()
        expect(fixtures.agent).toHaveBeenCalledWith(expect.objectContaining({ content: question,
            systemPrompt: expect.stringContaining('fixture/Measured-Model') }))
        expect(fixtures.cache).not.toHaveBeenCalled()
    }, 15000)

    it('adds current-state guidance to the short node correction and bypasses stale replies', async () => {
        await run('ns1 sorry')
        expect(fixtures.agent).toHaveBeenCalledWith(expect.objectContaining({
            systemPrompt: expect.stringContaining('ungeprüft'), content: 'ns1 sorry' }))
        expect(fixtures.cache).not.toHaveBeenCalled()
    }, 15000)

    it.each(['send mir mal einen screnn schots von allen nodes bitte',
        'was können deine nodes? send mir einen screnn shot vbon jeden'])('does not deliver a catalog or wrong desktop for %s', async text => {
        const { replies } = await run(text)
        expect(fixtures.agent).toHaveBeenCalledOnce()
        expect(replies.at(-1)).toContain('mesh_screenshot benötigt')
        expect(replies.at(-1)).toContain('keine Bilddatei übertragen')
        expect(replies.at(-1)).not.toContain('RAW CATALOG')
        expect(fixtures.capture).not.toHaveBeenCalled()
        expect(fixtures.photo).not.toHaveBeenCalled()
        expect(fixtures.cache).not.toHaveBeenCalled()
    }, 15000)
})
