/**
 * 2.89.4 LIVE: echter Eingang (createDaemonMessageEntry → message pipeline).
 *
 * Ein Owner schickt einen API-Schlüssel mit Zweck und Übernahme-Willen. Der Wert
 * wird im verschlüsselten Speicher abgelegt, die Telegram-Nachricht gelöscht,
 * und er steht in KEINER Antwort, KEINEM Sitzungsprotokoll und KEINEM
 * Modellaufruf. Fake-Wert `'x'.repeat(32)`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE = 'x'.repeat(32)

const fixtures = vi.hoisted(() => ({
    agent: vi.fn(),
    deleteMessage: vi.fn(async () => true),
    storeToolKey: vi.fn(async () => ({ ok: true, message: 'im Tresor als „chat-home-assistant“' })),
    storeLlmKey: vi.fn(async () => ({ ok: true, message: 'verbunden' })),
    testKey: vi.fn(async () => ({ ok: true, message: 'Format geprüft (kein Live-Test hinterlegt)' })),
}))
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
vi.mock('../learning/capability-learning.js', async importOriginal => ({
    ...await importOriginal<typeof import('../learning/capability-learning.js')>(),
    capabilityGate: async () => null, capabilityReplyGate: async (_r: string, reply: string) => reply, capabilityHonestyPrompt: () => '',
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: () => '' }))
vi.mock('./approval-card-sources.js', async importOriginal => ({ ...await importOriginal<typeof import('./approval-card-sources.js')>(), startApprovalCardLoop: () => undefined }))
// Real detector; store/test hooks are fakes so the live test can assert on them
// without writing a real vault. The pipeline injects its own deps; this wrap
// replaces only those three.
vi.mock('../secrets/chat-key-intake.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../secrets/chat-key-intake.js')>()
    return {
        ...actual,
        intakeOwnerChatSecret: (text: string, meta: any, deps: any) => actual.intakeOwnerChatSecret(text, meta, {
            ...deps,
            storeToolKey: fixtures.storeToolKey,
            storeLlmKey: fixtures.storeLlmKey,
            testKey: fixtures.testKey,
        }),
    }
})

const { handleMessage, logSession } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')
const { resetChatKeyIntake } = await import('../secrets/chat-key-intake.js')
const { forgetSecretValues, registerSecretValue } = await import('../security/secret-redaction.js')

let dataDir = ''
const state: any = {
    config: {}, startTime: Date.now(), tools: { execute: vi.fn() },
    channels: { telegram: { deleteMessage: fixtures.deleteMessage } },
    llm: { modelId: 'chat-a', providerId: 'none', runtimeModelIdentity: async () => ({ model: 'chat-a' }), complete: vi.fn(async () => ({ content: 'unexpected model answer' })) },
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand: async () => null })

beforeAll(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })
beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'chat-key-'))
    vi.spyOn(process, 'cwd').mockReturnValue(dataDir)
    fixtures.agent.mockClear()
    fixtures.deleteMessage.mockClear()
    fixtures.storeToolKey.mockClear()
    fixtures.storeLlmKey.mockClear()
    fixtures.testKey.mockClear()
    fixtures.storeToolKey.mockResolvedValue({ ok: true, message: 'im Tresor als „chat-home-assistant“' })
    fixtures.testKey.mockResolvedValue({ ok: true, message: 'Format geprüft (kein Live-Test hinterlegt)' })
    resetChatKeyIntake()
    forgetSecretValues()
})

async function ask(content: string, messageId: number | string = 42): Promise<string[]> {
    const replies: string[] = []
    await entry('Telegram', 'live-owner', content, async text => { replies.push(text) },
        undefined, undefined, { chatId: 'live-owner', messageId })
    return replies
}

const logLines: string[] = []
beforeAll(() => {
    const original = console.log
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logLines.push(args.map(String).join(' '))
        original(...args)
    })
})

function sessionDump(): string {
    try {
        return readdirSync(join(dataDir, '.nova-data', 'sessions'))
            .map(name => readFileSync(join(dataDir, '.nova-data', 'sessions', name), 'utf8'))
            .join('\n')
    } catch {
        return ''
    }
}

describe('LIVE: Schlüssel aus dem Chat (echter Eingang)', () => {
    it('takes the key over, deletes the message and keeps the value out of every sink', async () => {
        const replies = await ask(`Hier der Home Assistant API Key: ${FAKE} — nimm den und trag ihn ein`)
        expect(replies.length).toBe(1)
        const reply = replies.join('\n')
        expect(reply).toContain('Home Assistant')
        expect(reply).toContain('gelöscht')
        expect(reply).not.toContain(FAKE)
        expect(fixtures.deleteMessage).toHaveBeenCalledWith('live-owner', 42)
        expect(fixtures.storeToolKey).toHaveBeenCalled()
        expect(fixtures.storeToolKey.mock.calls[0][2]).toBe(FAKE)
        // The model never saw the message.
        expect(fixtures.agent).not.toHaveBeenCalled()
        for (const call of fixtures.agent.mock.calls) {
            expect(JSON.stringify(call)).not.toContain(FAKE)
        }
        expect(sessionDump()).not.toContain(FAKE)
        // The request-tracer completion line is a log sink — it must be redacted too.
        const logged = logLines.join('\n')
        expect(logged).not.toContain(FAKE)
        expect(logged).toMatch(/REDACTED|TRESOR|SCHLÜSSEL/)
    })

    it('finishes on the purpose answer without ever putting the value into the model', async () => {
        await ask(`API Key: ${FAKE} — trag ihn ein`, 42)
        const replies = await ask('Home Assistant', 43)
        expect(replies.join('\n')).not.toContain(FAKE)
        expect(fixtures.agent).not.toHaveBeenCalled()
        expect(fixtures.storeToolKey).toHaveBeenCalled()
        expect(fixtures.storeToolKey.mock.calls[0][2]).toBe(FAKE)
        expect(sessionDump()).not.toContain(FAKE)
    })

    it('redacts a registered secret even when something writes it into the session log', () => {
        registerSecretValue(FAKE, 'unit-test')
        logSession('live-owner', 'Telegram', 'user', `roh ${FAKE}`)
        const dump = sessionDump()
        expect(dump).not.toContain(FAKE)
        expect(dump).toContain('[TRESOR:')
    })
})
