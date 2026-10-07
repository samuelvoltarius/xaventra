/**
 * 2.89 Paket E — „Pipeline-Reihenfolge, Kanäle, keine stillen Fehler“.
 *
 * Every case runs through the REAL entry (createDaemonMessageEntry → message
 * pipeline) and, where a channel is involved, through the real channel wiring
 * (startWhatsApp / startDiscord / startDashboard / startRestApi). Only the model
 * is a scripted test agent; no network, no Telegram, no real accounts.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest, type Server } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
    agent: vi.fn(),
    permissions: new Map<string, { permission: string; permissionSource?: string }>(),
    trackGroup: vi.fn(),
    tg: null as any,
    adapters: {} as Record<string, any>,
    dashboardHandler: null as null | ((message: string, channel: string) => Promise<string>),
    clarify: vi.fn(),
    observe: vi.fn(),
    capability: vi.fn(),
    memoryContext: vi.fn(),
    cardLoop: vi.fn(),
}))
const key = (channel: string, from: string) => `${channel.toLowerCase()}:${from}`

vi.mock('../users/multi-user-middleware.js', () => ({
    initMultiUser: () => undefined,
    checkAuth: (from: string, channel: string) => {
        const entry = fixtures.permissions.get(key(channel, from)) || { permission: 'user' }
        return { allowed: true, permission: entry.permission, isNewUser: false, user: { id: from, channel, permissionSource: entry.permissionSource } }
    },
    getUserPermission: (from: string, channel: string) => (fixtures.permissions.get(key(channel || 'telegram', from)) || { permission: 'user' }).permission,
    getOrCreateUser: (from: string, channel: string) => {
        if (!fixtures.permissions.has(key(channel, from))) fixtures.permissions.set(key(channel, from), { permission: 'user' })
        return { id: from, channel }
    },
    setUserPermission: (from: string, permission: string) => {
        for (const [k, v] of fixtures.permissions) if (k.endsWith(`:${from}`)) { v.permission = permission; v.permissionSource = 'explicit' }
        return true
    },
    // Same rule as the real middleware: a chat id other than the sender is a group.
    isGroupChat: (chatId: string, userId: string) => chatId !== userId,
    trackGroupMessage: fixtures.trackGroup,
    shouldCoalesce: () => false, isCoalescedMarker: () => false,
    coalesceMessage: async (_chat: string, _from: string, text: string) => text,
    getOnboardingMessage: () => null, getUserContextString: () => '', getGroupContext: () => '', addUserTopic: () => undefined,
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
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test', completeTask: () => undefined, recordTokens: () => undefined }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../channels/telegram.js', () => ({ getTelegramAdapter: () => fixtures.tg }))
vi.mock('./clarification-gate.js', () => ({ evaluateClarification: fixtures.clarify }))
vi.mock('./decisions.js', () => ({
    observeOwnerMessage: fixtures.observe,
    buildDecisionContext: () => '',
    listDecisions: () => [],
}))
vi.mock('../learning/capability-learning.js', () => ({
    capabilityGate: fixtures.capability,
    capabilityReplyGate: async (_request: string, reply: string) => reply,
    capabilityHonestyPrompt: () => '',
}))
vi.mock('../memory/memory-context.js', () => ({ buildMemoryContext: fixtures.memoryContext }))
vi.mock('./approval-card-sources.js', async importOriginal => ({ ...(await importOriginal<any>()), startApprovalCardLoop: fixtures.cardLoop }))
vi.mock('../mesh/leader-election.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    shouldStartExclusiveService: async () => true,
    watchForServiceLeadership: () => undefined,
    onLeadershipLost: () => () => undefined,
}))
vi.mock('../channels/whatsapp.js', () => ({
    WhatsAppAdapter: class { send = vi.fn(async () => undefined); onMessage(handler: any) { fixtures.adapters.whatsapp = handler } async connect() {} async disconnect() {} },
}))
vi.mock('../channels/discord.js', () => ({
    DiscordAdapter: class { send = vi.fn(async () => undefined); onMessage(handler: any) { fixtures.adapters.discord = handler } async connect() {} async disconnect() {} },
}))
vi.mock('../sehen/aktivitaet.js', () => ({
    sammleAktivitaet: async () => ({ eintraege: [{ id: 'a1', titel: 'Backup prüfen', aktionen: ['stopp', 'spaeter'] }] }),
    aktivitaetText: () => 'Gerade aktiv: Backup prüfen',
}))
vi.mock('../dashboard/server.js', () => ({
    startDashboard: async () => 'http://127.0.0.1:0',
    setNovaMessageHandler: (handler: any) => { fixtures.dashboardHandler = handler },
    stopDashboard: async () => undefined,
}))

// logSession and stores write below process.cwd(); keep everything in a temp dir.
const sandbox = mkdtempSync(join(tmpdir(), 'pipeline-live-'))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)

const { handleMessage } = await import('./message-pipeline.js')
const { createDaemonMessageEntry } = await import('./daemon-message-entry.js')
const { OwnerAccountRegistry, setOwnerAccountRegistry } = await import('../users/owner-accounts.js')
const { ChannelHandoffLog, setChannelHandoffLog } = await import('../memory/channel-handoff.js')
const { ProjectCoordinator } = await import('./projects.js')
const { setProjectCoordinator } = await import('./projects-runtime.js')
const { setProgressFirstAfterForTests } = await import('./progress-notice.js')
const { UNVERIFIED_NOTE } = await import('./unverified-claims.js')
const slash = await import('./slash-commands.js')
const channels = await import('./daemon-channels.js')
const { startRestApi } = await import('../server/rest-api.js')

const config = { channels: { telegram: { allowFrom: ['1001'] } } }
const projectRuns: string[] = []
let state: any
const commandSpy = vi.fn()
const handleCommand = async (cmd: string, args: string, from: string, context?: any) => {
    commandSpy(cmd, args)
    return slash.handleCommand(cmd, args, from, state, [], context)
}
const entry = createDaemonMessageEntry({ pipeline: handleMessage as any, getState: () => state, handleCommand })

const answerFor = (userId: string) => `Antwort für ${userId}`
const agentResult = (content: string, extra: Record<string, unknown> = {}) => ({
    content, sessionId: 'fixture-session', toolsExecuted: [], toolExecutions: [],
    actionState: { requiresTool: false, kind: 'none', fulfilled: false }, ...extra,
})

beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__novaLastMsg = {}
    fixtures.tg = null
    fixtures.adapters = {}
    fixtures.dashboardHandler = null
    fixtures.permissions.clear()
    fixtures.permissions.set('telegram:1001', { permission: 'owner', permissionSource: 'configured' })
    fixtures.permissions.set('desktop:desktop:owner', { permission: 'owner', permissionSource: 'explicit' })
    fixtures.permissions.set('whatsapp:15555550111@s.whatsapp.net', { permission: 'owner', permissionSource: 'explicit' })
    fixtures.permissions.set('discord:100000000000000001', { permission: 'owner', permissionSource: 'explicit' })
    fixtures.clarify.mockImplementation((_principal: string, content: string) => ({ action: 'continue', content, missingFields: [], confidence: 1 }))
    fixtures.observe.mockImplementation(() => ({ created: [], confirmed: [], replaced: [], revoked: [], conflicts: [] }))
    fixtures.capability.mockResolvedValue({ handled: false })
    fixtures.memoryContext.mockResolvedValue('')
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-live-run-'))
    setOwnerAccountRegistry(new OwnerAccountRegistry(join(dir, 'owner-accounts.json')))
    setChannelHandoffLog(new ChannelHandoffLog(join(dir, 'handoff')))
    projectRuns.length = 0
    setProjectCoordinator(new ProjectCoordinator({ dataDir: join(dir, 'projekte'), ports: {
        run: async project => { projectRuns.push(project.ziel); return new Promise(() => undefined) },
        notify: async () => undefined,
    } }))
    fixtures.agent.mockImplementation(async (params: any) => agentResult(answerFor(params.userId)))
    state = {
        config, llm: { modelId: 'alias', providerId: 'local', complete: vi.fn(async () => ({ content: 'plain' })) },
        tools: { execute: vi.fn(), getAll: () => [], getStats: () => ({ total: 0 }) },
        channels: { telegram: null, whatsapp: null, discord: null }, startTime: Date.now(),
    }
})
afterEach(() => { setProgressFirstAfterForTests(null); vi.unstubAllEnvs() })
afterAll(() => { setOwnerAccountRegistry(null); setChannelHandoffLog(null); setProjectCoordinator(null); cwd.mockRestore() })

async function send(channel: string, from: string, content: string, execution?: any, messageContext?: any) {
    const replies: string[] = []
    await entry(channel, from, content, async text => { replies.push(text) }, undefined, execution, messageContext)
    return replies
}
const lastAgentCall = () => fixtures.agent.mock.calls.at(-1)?.[0]
const fakeTelegram = () => ({
    sendWithButtons: vi.fn(async () => undefined), sendModelSelector: vi.fn(async () => undefined), stopTyping: vi.fn(),
})

// ---------------------------------------------------------------------------
describe('1 — execution rest: cancellation-only is a user message', () => {
    it('Even-G2 sends a slash command with only an abort signal: it runs instead of throwing', async () => {
        fixtures.tg = fakeTelegram()
        const replies = await send('even-g2', 'even-g2:glasses', '/help', { abortSignal: new AbortController().signal })
        expect(replies).toHaveLength(1)
        expect(replies[0]).toMatch(/\/status/)
        expect(fixtures.tg.sendWithButtons).not.toHaveBeenCalled()
    }, 20000)

    it('Gegenprobe: a real mesh contract still cannot run slash commands', async () => {
        await expect(send('mesh', 'node-a', '/help', { allowedTools: ['read_file'], requestId: 'r1' })).rejects.toThrow(/cannot invoke slash commands/)
    }, 20000)

    it('Telegram gets at most ONE short progress message, only after the delay, however many steps run', async () => {
        setProgressFirstAfterForTests(40)
        fixtures.agent.mockImplementation(async (params: any) => {
            for (let step = 2; step <= 6; step++) await params.onStepUpdate(`⚙️ Schritt ${step}/6: web_search...`)
            await new Promise(resolve => setTimeout(resolve, 160))
            await params.onStepUpdate('⚙️ Schritt 6/6: read_file...')
            return agentResult('Fertig: drei Quellen gelesen.')
        })
        const replies = await send('Telegram', '1001', 'Recherchiere bitte die drei besten Quellen zum Thema Wärmepumpe')
        expect(replies).toHaveLength(2)
        expect(replies[0]).toMatch(/^⏳ Ich arbeite noch/)
        expect(replies[0]).not.toMatch(/web_search|Schritt/)
        expect(replies[1]).toBe('Fertig: drei Quellen gelesen.')
    }, 20000)

    it('Gegenprobe: a quick answer sends no progress at all', async () => {
        setProgressFirstAfterForTests(200)
        fixtures.agent.mockImplementation(async (params: any) => {
            await params.onStepUpdate('⚙️ Schritt 2/2: web_search...')
            return agentResult('Schnelle Antwort.')
        })
        expect(await send('Telegram', '1001', 'Wie warm wird es morgen in Salzburg?')).toEqual(['Schnelle Antwort.'])
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('2 — WhatsApp/Discord pass the chat: groups are groups', () => {
    it('a WhatsApp group message is a group (no owner project), the same owner in a direct chat starts one', async () => {
        await channels.startWhatsApp({ enabled: true } as any, entry as any, state)
        const deliver = fixtures.adapters.whatsapp
        await deliver({ id: 'w1', channel: 'whatsapp', from: '15555550111@s.whatsapp.net', content: 'Kümmer dich um die Steuererklärung', isGroup: true, groupId: '120363000000000001@g.us' })
        expect(fixtures.trackGroup).toHaveBeenCalledWith('120363000000000001@g.us', '15555550111@s.whatsapp.net', expect.anything())
        expect(projectRuns).toHaveLength(0)
        expect(fixtures.agent).toHaveBeenCalledTimes(1)
        await deliver({ id: 'w2', channel: 'whatsapp', from: '15555550111@s.whatsapp.net', content: 'Kümmer dich um die Steuererklärung', isGroup: false })
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(projectRuns).toHaveLength(1)
    }, 20000)

    it('a Discord guild message is a group; a DM (which also has a channel id) is not', async () => {
        await channels.startDiscord({ enabled: true, token: 'x'.repeat(20), allowFrom: ['100000000000000001'] } as any, entry as any, state)
        const deliver = fixtures.adapters.discord
        await deliver({ id: 'd1', channel: 'discord', from: '100000000000000001', content: 'Hallo zusammen', isGroup: true, groupId: '200000000000000002' })
        expect(fixtures.trackGroup).toHaveBeenCalledWith('200000000000000002', '100000000000000001', expect.anything())
        fixtures.trackGroup.mockClear()
        await deliver({ id: 'd2', channel: 'discord', from: '100000000000000001', content: 'Hallo privat', isGroup: false, groupId: '300000000000000003' })
        expect(fixtures.trackGroup).not.toHaveBeenCalled()
    }, 20000)

    it('adapterMessageContext: group id only for real groups', () => {
        expect(channels.adapterMessageContext({ from: 'a', isGroup: true, groupId: 'g' })).toEqual({ chatId: 'g' })
        expect(channels.adapterMessageContext({ from: 'a', isGroup: false, groupId: 'dm' })).toEqual({ chatId: 'a' })
    })
})

// ---------------------------------------------------------------------------
async function post(port: number, body: unknown, token?: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/message', headers: {
            'Content-Type': 'application/json', ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        } }, res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : null }))
        })
        req.on('error', reject)
        req.end(JSON.stringify(body))
    })
}

describe('3 — owner over REST only with proof; wakeword and mobile mesh never without', () => {
    let server: Server | undefined
    afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined } })

    it('a request with the valid API token is the owner (same principal as Telegram)', async () => {
        const token = 'x'.repeat(24)
        vi.stubEnv('NOVA_API_TOKEN', token)
        server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, entry as any, () => ({}))
        const port = (server.address() as any).port
        const res = await post(port, { content: 'Wie geht es dir heute?' }, token)
        expect(res.status).toBe(200)
        expect(lastAgentCall().userId).toBe('1001')
        expect(fixtures.permissions.get('rest-api:rest-api:token')?.permission).toBe('owner')
    }, 20000)

    it('Gegenprobe: a wrong token never reaches the pipeline, no token stays a plain user', async () => {
        vi.stubEnv('NOVA_API_TOKEN', 'x'.repeat(24))
        server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, entry as any, () => ({}))
        expect((await post((server.address() as any).port, { content: 'hi' }, 'y'.repeat(24))).status).toBe(401)
        expect(fixtures.agent).not.toHaveBeenCalled()
        server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined
        vi.stubEnv('NOVA_API_TOKEN', '')
        server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, entry as any, () => ({}))
        await post((server.address() as any).port, { content: 'Wie geht es dir heute?', from: '1001', channel: 'telegram' })
        expect(lastAgentCall().userId).toBe('rest-api:local')
        expect(fixtures.permissions.get('rest-api:rest-api:local')?.permission).not.toBe('owner')
    }, 20000)

    it('wakeword (local microphone) and mobile mesh have no owner proof and keep their own identity', async () => {
        await send('voice', 'local', 'Wie geht es dir heute?')
        expect(lastAgentCall().userId).toBe('local')
        await send('mobile-mesh', 'mesh-node-b', 'Wie geht es dir heute?')
        expect(lastAgentCall().userId).toBe('mesh-node-b')
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('4 — Telegram buttons only for Telegram', () => {
    it('/help from the Desktop returns text even though a Telegram adapter exists', async () => {
        fixtures.tg = fakeTelegram()
        const replies = await send('desktop', 'desktop:owner', '/help')
        expect(replies).toHaveLength(1)
        expect(replies[0]).toMatch(/\/status/)
        expect(fixtures.tg.sendWithButtons).not.toHaveBeenCalled()
    }, 20000)

    it('the natural way to /status from the Dashboard answers with text', async () => {
        fixtures.tg = fakeTelegram()
        const replies = await send('dashboard', 'dashboard', 'Status')
        expect(commandSpy).toHaveBeenCalledWith('status', '')
        expect(replies).toHaveLength(1)
        expect(replies[0].length).toBeGreaterThan(20)
        expect(fixtures.tg.sendWithButtons).not.toHaveBeenCalled()
    }, 20000)

    it('Telegram keeps its buttons; a failed button message falls back to text and is logged', async () => {
        fixtures.tg = fakeTelegram()
        expect(await send('Telegram', '1001', '/help')).toEqual([])
        expect(fixtures.tg.sendWithButtons).toHaveBeenCalledTimes(1)
        fixtures.tg.sendWithButtons.mockRejectedValueOnce(new Error('Bad Request: message is too long'))
        const warn = vi.spyOn(console, 'warn')
        const replies = await send('Telegram', '1001', '/help')
        expect(replies).toHaveLength(1)
        expect(replies[0]).toMatch(/\/status/)
        expect(warn.mock.calls.flat().join(' ')).toMatch(/\[Befehle\] Telegram-Knöpfe nicht gesendet/)
    }, 20000)
})

describe('4b — channel names are compared case-insensitively (adapter says „Telegram“)', () => {
    it('/aktivitaet from Telegram gets its stop/later buttons', async () => {
        fixtures.tg = fakeTelegram()
        expect(await send('Telegram', '1001', '/aktivitaet')).toEqual([])
        expect(fixtures.tg.sendWithButtons).toHaveBeenCalledWith('1001', 'Gerade aktiv: Backup prüfen', expect.any(Array))
    }, 20000)

    it('Gegenprobe: /aktivitaet from the Desktop is text', async () => {
        fixtures.tg = fakeTelegram()
        expect(await send('desktop', 'desktop:owner', '/aktivitaet')).toEqual(['Gerade aktiv: Backup prüfen'])
        expect(fixtures.tg.sendWithButtons).not.toHaveBeenCalled()
    }, 20000)
})

describe('2b — system messages never take the user fast path', () => {
    it('a self-goal „Beende den Auftrag“ does not stop a mission', async () => {
        await send('Telegram', 'Nova-Autonomy', 'Beende den Auftrag')
        expect(commandSpy).not.toHaveBeenCalledWith('mission', expect.anything())
    }, 20000)

    it('Gegenprobe: the owner saying it does; the negated sentence does not', async () => {
        await send('Telegram', '1001', 'Brich den Auftrag bitte nicht ab')
        expect(commandSpy).not.toHaveBeenCalledWith('mission', expect.anything())
        await send('Telegram', '1001', 'Beende den Auftrag')
        expect(commandSpy).toHaveBeenCalledWith('mission', 'stop')
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('5 — the card loop starts without Telegram', () => {
    it('startOwnerCardLoop starts the approval card loop (no Telegram adapter needed)', async () => {
        vi.stubEnv('NOVA_NO_SIDE_EFFECTS', '0')
        channels.startOwnerCardLoop()
        await vi.waitFor(() => expect(fixtures.cardLoop).toHaveBeenCalledTimes(1))
    })

    it('Gegenprobe: with side effects disabled nothing starts', async () => {
        vi.stubEnv('NOVA_NO_SIDE_EFFECTS', '1')
        channels.startOwnerCardLoop()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(fixtures.cardLoop).not.toHaveBeenCalled()
    })

    it('the daemon starts it with the Main control plane, stops it on Main loss; owner notices need the Main, not Telegram', () => {
        const daemon = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const lostAt = daemon.indexOf('onLeadershipLost(MAIN_SERVICE, async () => {')
        const plane = daemon.slice(daemon.indexOf('const activateMainControlPlane = async'), lostAt)
        expect(plane).toContain('startOwnerCardLoop()')
        const lost = daemon.slice(lostAt, daemon.indexOf('watchForServiceLeadership(MAIN_SERVICE, activateMainControlPlane)', lostAt))
        expect(lost).toContain('stopApprovalCardLoop()')
        const notify = daemon.slice(daemon.indexOf('.sendGovernedProactive = async'), daemon.indexOf('plannerActive: () => plannerConfigured'))
        expect(notify).toContain('verifyLiveServiceLeadership(MAIN_SERVICE)')
        expect(notify).not.toContain("verifyLiveServiceLeadership('telegram')")
        expect(notify).not.toContain("hasValidFence('telegram')")
    })
})

// ---------------------------------------------------------------------------
describe('6 — order of the early stages', () => {
    it('„Was machen meine Projekte?“ is the project status, not a memory recall', async () => {
        await send('Telegram', '1001', 'Kümmer dich um die Steuererklärung')
        commandSpy.mockClear()
        const [status] = await send('Telegram', '1001', 'Was machen meine Projekte?')
        expect(status).toMatch(/Steuererklärung/)
        expect(commandSpy).not.toHaveBeenCalledWith('memory', expect.anything())
    }, 20000)

    it('Gegenprobe: without projects the question still takes the memory fast path', async () => {
        await send('Telegram', '1001', 'Was machen meine Projekte?')
        expect(commandSpy).toHaveBeenCalledWith('memory', expect.stringMatching(/^recall-natural/))
    }, 20000)

    it('a plain-words rule is stored before the clarification gate asks back', async () => {
        fixtures.clarify.mockImplementation((_p: string, content: string) => ({ action: 'ask', question: 'Welches Gerät meinst du?', content, missingFields: ['target'], confidence: 0.5 }))
        const replies = await send('Telegram', '1001', 'Ab jetzt schaltest du das Licht abends immer auf 30 Prozent')
        expect(replies).toEqual(['Welches Gerät meinst du?'])
        expect(fixtures.observe).toHaveBeenCalledTimes(1)
        expect(fixtures.observe.mock.calls[0][0]).toMatchObject({ permission: 'owner', isGroup: false })
    }, 20000)

    it('the capability question is answered before the clarification gate', async () => {
        fixtures.clarify.mockImplementation((_p: string, content: string) => ({ action: 'ask', question: 'Welche Angabe fehlt noch?', content, missingFields: ['x'], confidence: 0.5 }))
        fixtures.capability.mockResolvedValue({ handled: true, reply: 'Nein, das kann ich noch nicht. Soll ich es lernen?' })
        expect(await send('Telegram', '1001', 'Kannst du ein Fax senden?')).toEqual(['Nein, das kann ich noch nicht. Soll ich es lernen?'])
    }, 20000)

    it('a learned correction answers only after the owner gates and never in a group', async () => {
        state.learning = { processUserMessage: vi.fn(() => ({ response: 'Gelernte Antwort', confidence: 0.9, source: 'correction' })) }
        await channels.startWhatsApp({ enabled: true } as any, entry as any, state)
        // group: the model answers, not the private correction
        await fixtures.adapters.whatsapp({ id: 'w3', channel: 'whatsapp', from: '15555550111@s.whatsapp.net', content: 'Wie heißt der Router?', isGroup: true, groupId: '120363000000000001@g.us' })
        expect(fixtures.agent).toHaveBeenCalledTimes(1)
        // owner gate first: the capability answer wins over a stored correction
        fixtures.capability.mockResolvedValueOnce({ handled: true, reply: 'Nein, das kann ich noch nicht. Soll ich es lernen?' })
        expect(await send('Telegram', '1001', 'Kannst du ein Fax senden?')).toEqual(['Nein, das kann ich noch nicht. Soll ich es lernen?'])
        // direct chat without a gate: the correction answers
        expect(await send('Telegram', '1001', 'Wie heißt der Router?')).toEqual(['Gelernte Antwort'])
    }, 20000)

    it('answers of the early paths land in the cross-channel handoff log', async () => {
        fixtures.capability.mockResolvedValueOnce({ handled: true, reply: 'Nein, Faxe kann ich noch nicht senden. Soll ich es lernen?' })
        await send('Telegram', '1001', 'Kannst du ein Fax senden?')
        await send('desktop', 'desktop:owner', 'Was hatte ich dich vorhin gefragt?')
        expect(lastAgentCall().systemPrompt).toContain('Xaventra: Nein, Faxe kann ich noch nicht senden')
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('7 — no silent failures; claims only with successful tools', () => {
    it('a failing memory context is logged with short context and without the message text', async () => {
        fixtures.memoryContext.mockRejectedValue(new Error('vector store offline'))
        const warn = vi.spyOn(console, 'warn')
        const replies = await send('Telegram', '1001', 'Erzähl mir etwas über mein Lieblingsprojekt Sonnenblume')
        expect(replies).toEqual([answerFor('1001')])
        const lines = warn.mock.calls.flat().map(String).filter(line => line.includes('Gedächtnis-Kontext'))
        expect(lines).toEqual(['[Pipeline] Gedächtnis-Kontext fehlgeschlagen: vector store offline'])
        expect(lines.join(' ')).not.toContain('Sonnenblume')
    }, 20000)

    it('a failed tool run is no evidence for „habe getestet / Verbindung steht“', async () => {
        fixtures.agent.mockResolvedValue(agentResult('Ich habe die Verbindung getestet, Verbindung steht.', {
            toolsExecuted: ['fetch_url'], toolExecutions: [{ toolName: 'fetch_url', success: false, result: 'timeout' }],
            actionState: { requiresTool: false, kind: 'none', fulfilled: true },
        }))
        const [reply] = await send('Telegram', '1001', 'Wie sieht es mit der Verbindung zum NAS aus?')
        expect(reply.startsWith(UNVERIFIED_NOTE)).toBe(true)
    }, 20000)

    it('Gegenprobe: a successful tool run keeps the claim as it is', async () => {
        fixtures.agent.mockResolvedValue(agentResult('Ich habe die Verbindung getestet, Verbindung steht.', {
            toolsExecuted: ['fetch_url'], toolExecutions: [{ toolName: 'fetch_url', success: true, result: '200 OK' }],
            actionState: { requiresTool: false, kind: 'none', fulfilled: true },
        }))
        const [reply] = await send('Telegram', '1001', 'Wie sieht es mit der Verbindung zum NAS aus?')
        expect(reply).toBe('Ich habe die Verbindung getestet, Verbindung steht.')
    }, 20000)

    it('the plain-model fallback passes the claim guard too', async () => {
        fixtures.agent.mockRejectedValue(new Error('provider 500'))
        state.llm.complete.mockResolvedValue({ content: 'Ich habe es geprüft, curl funktioniert.' })
        const [reply] = await send('Telegram', '1001', 'Geht der Webserver auf dem NAS?')
        expect(reply.startsWith(UNVERIFIED_NOTE)).toBe(true)
        expect(reply).toContain('curl funktioniert')
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('9 — Dashboard/Desktop: status lines never mix into the room answer', () => {
    it('the dashboard reply contains only the answer, the notice stays out', async () => {
        setProgressFirstAfterForTests(5)
        await channels.startDashboard({ enabled: true, port: 0 } as any, entry as any, state)
        fixtures.agent.mockImplementation(async (params: any) => {
            await params.onStepUpdate('⚙️ Schritt 2/3: web_search...')
            await params.onStepUpdate('Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.')
            await new Promise(resolve => setTimeout(resolve, 40))
            return agentResult('Hier ist die fertige Antwort.')
        })
        const response = await fixtures.dashboardHandler!('Fasse bitte die Lage zusammen', 'dashboard')
        expect(response).toBe('Hier ist die fertige Antwort.')
    }, 20000)

    it('a side sink still sees the status lines (never the answer channel)', async () => {
        const seen: string[] = []
        fixtures.agent.mockImplementation(async (params: any) => {
            await params.onStepUpdate('Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.')
            return agentResult('Antwort.')
        })
        const replies = await send('dashboard', 'dashboard', 'Fasse bitte die Lage zusammen', undefined, { onProgress: (status: string) => seen.push(status) })
        expect(replies).toEqual(['Antwort.'])
        expect(seen).toEqual(['Codex ist gerade nicht erreichbar – ich arbeite lokal weiter.'])
    }, 20000)
})

// ---------------------------------------------------------------------------
describe('8 — mission engine and project resume do not depend on the autonomy loop', () => {
    it('initMissionEngine and the project resume sit outside the autonomy-loop try', () => {
        const daemon = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const autonomyEnd = daemon.indexOf('Autonomy Loop nicht verfügbar')
        expect(autonomyEnd).toBeGreaterThan(0)
        expect(daemon.indexOf('initMissionEngine({')).toBeGreaterThan(autonomyEnd)
        const missionCatch = daemon.indexOf('Mission Engine nicht verfügbar')
        expect(daemon.indexOf("import('./core/projects-runtime.js').then(({ getProjectCoordinator })")).toBeGreaterThan(missionCatch)
    })
})

describe('7b — runner stages are not silent any more', () => {
    it('the named optional runner stages log a warning instead of an empty catch', () => {
        const runner = readFileSync(fileURLToPath(new URL('../agents/nova-runner.ts', import.meta.url)), 'utf8')
        const stages = ['Mesh-Delegation', 'Gelernte Tool-Beispiele', 'Prozeduren (Abruf)', 'Fähigkeits-Lernen', 'Tool-Lernen (Erfolg)',
            'Tool-Lernen (Fehler)', 'Werkzeug-Bedarf', 'Episoden-Lernen', 'Prozeduren (Ergebnis)']
        for (const stage of stages) expect(runner).toContain("runnerStageFailure('" + stage + "', error)")
        for (const silent of ['procedures are not critical', 'learning is non-critical', 'L7 not critical', 'the forge need hook is optional']) {
            expect(runner).not.toContain('catch { /* ' + silent + ' */ }')
        }
    })
})
