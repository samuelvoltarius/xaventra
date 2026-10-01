import { beforeEach, describe, expect, it, vi } from 'vitest'

// Live 01.10.2026 on the Spark: Codex 0.159.2 installed and logged in for the
// owner, codex.enabled=false, every message ran over local vLLM qwen — while
// /codex status answered "Codex wird bevorzugt". The status checked only
// "installed and logged in", never the routing switch.

const runtime = vi.hoisted(() => ({
    available: true,
}))

vi.mock('../auth/codex-runtime.js', () => ({
    probeCodexContinuity: vi.fn(async () => ({
        available: runtime.available,
        activeNodeId: runtime.available ? 'spark' : undefined,
        localStatus: { nodeId: 'spark', available: true, authenticated: runtime.available, authMode: null, planType: null, checkedAt: new Date().toISOString() },
        knownNodeIds: ['spark'],
        fallback: { endpoint: 'http://127.0.0.1:8000/v1', model: 'qwen', nodeId: 'spark', hostname: 'spark' },
        checkedAt: new Date().toISOString(),
    })),
    getCodexDisplayModel: vi.fn(async () => ({
        provider: 'openai-codex', model: 'gpt-5.4', local: false, nodeId: 'spark',
        available: runtime.available, authenticated: runtime.available, preferred: false,
    })),
}))

const { handleCommand } = await import('./slash-commands.js')

function state(codex: Record<string, unknown>): any {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: { codex }, __userPermission: 'owner',
    }
}

const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }

describe('/codex status tells the truth about the routing switch', () => {
    beforeEach(() => { runtime.available = true })

    it('says off and "wäre Codex, aber aus" when codex.enabled=false, even if logged in', async () => {
        const text = String(await handleCommand('codex', 'status', 'owner-1', state({ enabled: false }), [], owner))
        expect(text).not.toMatch(/wird bevorzugt/)
        expect(text).toMatch(/aus/)
        expect(text).toContain('wäre Codex, aber aus')
        expect(text).toContain('qwen')
    })

    it('names the task kinds Codex is chosen for when enabled', async () => {
        const text = String(await handleCommand('codex', 'status', 'owner-1', state({ enabled: true }), [], owner))
        expect(text).toMatch(/wird für .*Code.* gewählt/)
        expect(text).toMatch(/Smalltalk/)
    })

    it('says enabled but unavailable when no node has a login', async () => {
        runtime.available = false
        const text = String(await handleCommand('codex', 'status', 'owner-1', state({ enabled: true }), [], owner))
        expect(text).toMatch(/nicht verfügbar/)
        expect(text).not.toMatch(/wird für .*gewählt/)
    })

    it('does not tell a non-owner that Codex would serve them', async () => {
        const text = String(await handleCommand('codex', 'status', 'user-1', state({ enabled: true }), [], {
            channel: 'cli', rawUserId: 'user-1', principalId: 'user-1', permission: 'user',
        }))
        expect(text).toMatch(/nur für den Owner/)
    })

    it('/model does not claim "automatisch bevorzugt" while codex.enabled=false', async () => {
        const text = String(await handleCommand('model', 'gpt-5.4', 'owner-1', state({ enabled: false }), [], owner))
        expect(text).not.toMatch(/bevorzugt/)
        expect(text).toContain('wäre Codex, aber aus')
    })
})
