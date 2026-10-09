/**
 * 2.89.4 LIVE: echter Eingang (createDaemonMessageEntry → message pipeline).
 *
 * Nutzer-Korrekturen zu Diensten („läuft doch schon“, „solltest du schon
 * verbunden sein“) werden sofort live geprüft und verbinden oder melden das
 * Prüfergebnis ehrlich — nie ungeprüft übernommen, nie auf ein anderes Thema.
 * „Läuft“ in der Antwort nur mit Sondenantwort in diesem Lauf.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test', completeTask: () => undefined, recordTokens: () => undefined }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../learning/capability-learning.js', async importOriginal => ({
    ...await importOriginal<typeof import('../learning/capability-learning.js')>(),
    capabilityGate: async () => null, capabilityReplyGate: async (_r: string, reply: string) => reply, capabilityHonestyPrompt: () => '',
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: () => '' }))
vi.mock('./approval-card-sources.js', async importOriginal => ({ ...await importOriginal<typeof import('./approval-card-sources.js')>(), startApprovalCardLoop: () => undefined }))

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')
const { resetServiceProbeEvidence } = await import('./service-run-truth.js')

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

beforeAll(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })

beforeEach(() => {
    fixtures.agent.mockReset()
    fixtures.agent.mockResolvedValue({ content: 'unexpected model answer', toolsExecuted: [], sessionId: 's', toolExecutions: [], actionState: { requiresTool: false, kind: 'none', fulfilled: false } })
    resetServiceProbeEvidence()
    vi.unstubAllEnvs()
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
})

describe('2.89.4: Dienst-Korrekturen am echten Eingang', () => {
    it('„läuft doch schon“ wird live geprüft und nicht ungeprüft übernommen', async () => {
        // nichts antwortet
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
        const replies = await ask('Der Sprachdienst läuft doch schon.')
        const text = replies.join('\n')
        expect(text).toMatch(/live geprüft|nicht ungeprüft/)
        expect(text).toMatch(/nicht erreichbar|nicht geprüft/)
        expect(text).toContain('läuft doch schon')
        expect(text).not.toMatch(/ja, stimmt|du hattest recht|wie wäre es richtig/i)
        expect(fixtures.agent).not.toHaveBeenCalled()
    })

    it('„solltest du schon verbunden sein“: antwortende Sonde → läuft (geprüft) und verbunden', async () => {
        vi.stubEnv('XAVENTRA_STT_BASE_URL', 'http://127.0.0.1:8018')
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.1:5002')
        vi.stubGlobal('fetch', vi.fn(async (url: any) => {
            const text = String(url)
            if (text.includes(':8018') || text.includes(':5002') || text.endsWith('/v1/models')) {
                return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
            }
            return new Response('nope', { status: 404 })
        }))
        const replies = await ask('Du solltest doch schon verbunden sein.')
        const text = replies.join('\n')
        expect(text).toMatch(/Spracherkennung \(STT\): läuft \(geprüft\)|Sprachausgabe \(TTS\): läuft \(geprüft\)/)
        expect(text).toMatch(/Verbunden/)
        expect(text).toMatch(/recht/)
        expect(fixtures.agent).not.toHaveBeenCalled()
    })

    it('bleibt beim Thema — keine andere Frage als Antwort', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
        const replies = await ask('Whisper läuft doch schon.')
        const text = replies.join('\n')
        expect(text).toMatch(/Whisper/)
        expect(text).not.toMatch(/wie heiße ich|hast du internet|was machen meine projekte/i)
    })
})
