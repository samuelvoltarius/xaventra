import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// One owner across channels, through the real message pipeline (scripted agent,
// no network). Telegram 1001 is the configured owner, desktop:owner the
// token-checked App owner, 3003 a stranger, telefon:… a phone caller.
const fixtures = vi.hoisted(() => ({
    agent: vi.fn(),
    permissions: new Map<string, { permission: string; permissionSource?: string }>(),
    granted: [] as string[],
}))
const key = (channel: string, from: string) => `${channel.toLowerCase()}:${from}`
vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: (from: string, channel: string) => {
        const entry = fixtures.permissions.get(key(channel, from)) || { permission: 'user' }
        return { allowed: true, permission: entry.permission, isNewUser: false, user: { id: from, channel, permissionSource: entry.permissionSource } }
    },
    getUserPermission: (from: string, channel: string) => (fixtures.permissions.get(key(channel, from)) || { permission: 'user' }).permission,
    setUserPermission: (from: string, permission: string) => { fixtures.granted.push(`${from}=${permission}`); for (const [k, v] of fixtures.permissions) if (k.endsWith(`:${from}`)) v.permission = permission; if (![...fixtures.permissions.keys()].some(k => k.endsWith(`:${from}`))) fixtures.permissions.set(`slack:${from}`, { permission, permissionSource: 'explicit' }); return true },
    isGroupChat: () => false, shouldCoalesce: () => false, isCoalescedMarker: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
}))
vi.mock('./soul.js', () => ({
    soulExists: () => true, buildSystemPromptFromSoul: () => 'Fixture identity', loadSoul: () => ({}),
    getOnboardingMessage: () => '', isOnboardingResponse: () => false,
    parseOnboardingResponse: () => ({}), saveSoul: () => undefined, getOnboardingConfirmation: () => '',
}))
vi.mock('../agents/nova-runner.js', () => ({ runNovaAgent: fixtures.agent, clearSession: () => undefined }))
vi.mock('../llm/response-cache.js', () => ({ getCachedResponse: () => null, cacheResponse: vi.fn() }))
vi.mock('../layers/L12-anti-hallucination.js', () => ({ validateWithLLM: vi.fn(async () => ({ honest: true, issues: [] })) }))
vi.mock('../tools/skill-builder.js', () => ({ noteForgeNeed: () => ({ queued: false }) }))
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../voice/telefon-config.js', () => ({
    readTelefonConfig: () => ({ ownerNummern: ['+15555550100'] }),
    isOwnerNumber: (caller: string, list: string[]) => list.includes(String(caller)),
}))

const { handleMessage } = await import('./message-pipeline.js')
const { OwnerAccountRegistry, setOwnerAccountRegistry } = await import('../users/owner-accounts.js')
const { ChannelHandoffLog, setChannelHandoffLog } = await import('../memory/channel-handoff.js')
const { ProjectCoordinator } = await import('./projects.js')
const { setProjectCoordinator } = await import('./projects-runtime.js')

const config = { channels: { telegram: { allowFrom: ['1001'] } } }
const projectRuns: string[] = []

beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__novaLastMsg = {}
    fixtures.granted.length = 0
    fixtures.permissions.clear()
    fixtures.permissions.set('telegram:1001', { permission: 'owner', permissionSource: 'configured' })
    fixtures.permissions.set('desktop:desktop:owner', { permission: 'owner', permissionSource: 'explicit' })
    fixtures.permissions.set('desktop:telefon:+15555550100', { permission: 'user' })
    fixtures.permissions.set('telegram:3003', { permission: 'user' })
    const dir = mkdtempSync(join(tmpdir(), 'one-owner-'))
    setOwnerAccountRegistry(new OwnerAccountRegistry(join(dir, 'owner-accounts.json')))
    setChannelHandoffLog(new ChannelHandoffLog(join(dir, 'handoff')))
    projectRuns.length = 0
    setProjectCoordinator(new ProjectCoordinator({ dataDir: join(dir, 'projekte'), ports: {
        run: async project => { projectRuns.push(project.ziel); return new Promise(() => undefined) },
        notify: async () => undefined,
    } }))
    fixtures.agent.mockImplementation(async (params: any) => ({
        content: `Antwort für ${params.userId}`, sessionId: 'fixture-session', toolsExecuted: [], toolExecutions: [],
        actionState: { requiresTool: false, kind: 'none', fulfilled: false },
    }))
})
afterAll(() => { setOwnerAccountRegistry(null); setChannelHandoffLog(null); setProjectCoordinator(null) })

async function send(channel: string, from: string, content: string) {
    const replies: string[] = []
    const state: any = { config, llm: { modelId: 'alias', providerId: 'local', complete: vi.fn() }, tools: { execute: vi.fn() }, startTime: Date.now() }
    await handleMessage(channel, from, content, async text => { replies.push(text) }, state, async () => '')
    return replies
}
const lastAgentCall = () => fixtures.agent.mock.calls.at(-1)?.[0]

describe('one owner, one context across channels (pipeline)', () => {
    it('Telegram and the App share the owner principal and see each other', async () => {
        await send('Telegram', '1001', 'Merk dir, wir nehmen für das Wohnzimmer die grüne Lampe')
        expect(lastAgentCall().userId).toBe('1001')
        await send('desktop', 'desktop:owner', 'Welche Lampe hatten wir ausgesucht?')
        expect(lastAgentCall().userId).toBe('1001')
        expect(lastAgentCall().systemPrompt).toContain('grüne Lampe')
        expect(lastAgentCall().systemPrompt).toContain('Zuletzt in anderen Kanälen')
    }, 20000)

    it('a phone call from the owner number is known afterwards in Telegram, but the caller never reads the owner context', async () => {
        await send('Telegram', '1001', 'Geheimes Projekt Sonnenblume bitte merken')
        await send('desktop', 'telefon:+15555550100', 'Bitte erinnere mich an den Zahnarzttermin am Freitag')
        expect(lastAgentCall().userId).toBe('telefon:+15555550100')
        expect(lastAgentCall().systemPrompt).not.toContain('Sonnenblume')
        await send('Telegram', '1001', 'Was hatte ich vorhin am Telefon gesagt?')
        expect(lastAgentCall().systemPrompt).toContain('Zahnarzttermin')
        expect(lastAgentCall().systemPrompt).toContain('nicht geprüft')
    }, 20000)

    it('a stranger stays separate from the owner', async () => {
        await send('Telegram', '1001', 'Mein Kontostand-Ziel ist geheim: Urlaub in Kanada')
        await send('Telegram', '3003', 'Was weißt du über Kanada?')
        expect(lastAgentCall().userId).toBe('3003')
        expect(lastAgentCall().systemPrompt).not.toContain('Urlaub in Kanada')
    }, 20000)

    it('a further channel joins with the link code, without config files', async () => {
        await send('Telegram', '1001', 'Hallo')
        const [codeReply] = await send('Telegram', '1001', 'Ich will Slack mit dir verknüpfen')
        const code = /(\d{6})/.exec(codeReply)![1]
        const [linked] = await send('slack', 'U1', `verknüpfen ${code}`)
        expect(linked).toMatch(/Verbunden/)
        expect(fixtures.granted).toContain('U1=owner')
        await send('slack', 'U1', 'Wie geht es dir heute?')
        expect(lastAgentCall().userId).toBe('1001')
        // demoted again: the account loses the owner's context at once
        fixtures.permissions.set('slack:U1', { permission: 'user' })
        await send('slack', 'U1', 'Was weißt du über mich?')
        expect(lastAgentCall().userId).toBe('U1')
    }, 20000)
})

describe('projects from plain conversation (pipeline)', () => {
    it('starts two projects without a command and lists them from another channel', async () => {
        const [reply] = await send('Telegram', '1001', 'Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche')
        expect(reply).toMatch(/parallel/)
        expect(fixtures.agent).not.toHaveBeenCalled()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(projectRuns).toHaveLength(2)
        await send('desktop', 'desktop:owner', 'Hallo')
        const [status] = await send('desktop', 'desktop:owner', "Wie steht's?")
        expect(status).toMatch(/Steuererklärung/)
        expect(status).toMatch(/Küche/)
    }, 20000)

    it('a stranger cannot start projects', async () => {
        await send('Telegram', '3003', 'Kümmer dich um meinen Garten')
        expect(projectRuns).toHaveLength(0)
        expect(fixtures.agent).toHaveBeenCalledTimes(1)
    }, 20000)
})