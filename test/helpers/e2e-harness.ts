/**
 * End-to-end harness over the REAL daemon entry (Paket D, 2.89 "Echte Abnahme").
 *
 * Path under test, exactly as in production:
 *   createDaemonMessageEntry → message-pipeline.handleMessage → runNovaAgent
 *   with the real tool registry and the real tool router (filtered mode;
 *   NOVA_OS_MODE / NOVA_ALL_TOOLS / NOVA_MAX_TOOL_ROUNDS unset like the live Main).
 *
 * The only fake is the model: a scriptable client on state.llm.complete that
 * records, per round, which tools the router offered. Everything else is real
 * code. Around it sit only recording transports and a simulated environment:
 *   - Telegram: the real adapter object, its network methods record instead of send;
 *   - Desktop: the desktop-api path (runWithDesktopAgentContext + abort signal);
 *   - REST: the real REST server on a loopback port (bearer token → `rest-api:token`, owner grant);
 *   - network: closed (fetch rejects) except explicit environment routes
 *     (e.g. a SearXNG instance on searxng.example.com).
 * The production profile is the default: the test-mode switches that make
 * `sideEffectsDisabled()` true are cleared during a turn, so gates that are
 * dark in unit tests (learning question, decisions …) run like on the Main.
 *
 * Every harness gets its own temp runtime root (NOVA_RUNTIME_ROOT + chdir) and a
 * fresh module graph (vi.resetModules), so state never leaks between tests.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dgram from 'node:dgram'
import net from 'node:net'
import { vi } from 'vitest'

export const OWNER_TELEGRAM_ID = '700000001'
export const STRANGER_TELEGRAM_ID = '700000999'
export const DESKTOP_OWNER = 'owner'
export const REST_TOKEN = 'e2e-' + 'x'.repeat(20)
export const SEARXNG_URL = 'http://searxng.example.com'

export interface ScriptedToolCall { name: string; arguments?: Record<string, unknown> }
export type ScriptStep =
    | { tool: string; args?: Record<string, unknown> }
    | { tools: ScriptedToolCall[] }
    | { text: string }
    | { delayMs: number; then: ScriptStep }
    | ((call: LlmCall) => ScriptStep | Promise<ScriptStep>)

export interface LlmCall {
    index: number
    /** Tool names offered to the model in this call. */
    tools: string[]
    messages: Array<{ role: string; content: any }>
    options: Record<string, unknown>
    /** True when the call belongs to the current turn's agent run (consumes the script). */
    scripted: boolean
}

export interface TurnResult {
    /** Every text delivered through the channel reply callback, in order. */
    replies: string[]
    /** Last delivered text (what the user sees last). */
    final: string
    /** Telegram sendWithButtons calls during this turn. */
    buttons: Array<{ to: string; text: string; keyboard: unknown }>
    /** Model calls during this turn. */
    calls: LlmCall[]
    /** Agent model calls of this turn only. */
    rounds: LlmCall[]
    /** Tool names offered in the first agent call. */
    offeredTools: string[]
    /** Tools the governed executor actually started (from the runner log). */
    executedTools: string[]
    /** traceStep markers of this turn, in order. */
    trace: string[]
    /** Every console line of this turn. */
    logs: string[]
    /** Desktop outcome (desktop channel only). */
    outcome?: any
    error?: unknown
    durationMs: number
}

export interface EnvironmentRoute {
    match: RegExp
    respond: (url: string, init?: any) => { status?: number; json?: unknown; text?: string }
}

export interface HarnessOptions {
    /** Production profile: clear the test-mode switches during a turn. Default true. */
    liveProfile?: boolean
    /** Extra config merged into xaventra.config.json. */
    config?: Record<string, unknown>
    /** Default answer once the script is exhausted. */
    fallbackText?: string
    /** Prepare the runtime root before the modules load (seed data files). */
    seed?: (root: string) => void | Promise<void>
    /** Without SOUL.md (first start, onboarding). */
    noSoul?: boolean
    /** Simulated environment reachable over fetch (everything else is closed). */
    routes?: EnvironmentRoute[]
    /** A SearXNG instance on this machine, already in use (connection list + search route). */
    searxng?: boolean
    /** Reuse the runtime root of an earlier harness (a restart: files stay, memory is fresh). */
    reuseRoot?: string
    /** Keep the runtime root on close (for a later `reuseRoot`). */
    keepRoot?: boolean
}

const LIVE_UNSET = ['NOVA_OS_MODE', 'NOVA_ALL_TOOLS', 'NOVA_MAX_TOOL_ROUNDS', 'NOVA_AGENT_TIMEOUT_MS', 'NOVA_NODE_ONLY', 'NOVA_NO_TELEGRAM', 'NOVA_SEARXNG_URL']
const TEST_SWITCHES = ['NOVA_NO_SIDE_EFFECTS', 'NOVA_TEST_MODE', 'VITEST', 'NODE_ENV']

function stepToResponse(step: Exclude<ScriptStep, (...args: any[]) => any>, index: number): any {
    const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
    if ('text' in step) return { content: step.text, toolCalls: [], finishReason: 'stop', usage }
    if ('delayMs' in step) throw new Error('delay steps are resolved before')
    const calls = 'tools' in step ? step.tools : [{ name: step.tool, arguments: step.args || {} }]
    return {
        content: '',
        toolCalls: calls.map((call, i) => ({ id: `e2e-call-${index}-${i}`, name: call.name, arguments: call.arguments || {} })),
        finishReason: 'tool_calls',
        usage,
    }
}

function messageText(value: any): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text || '').join(' ')
    return ''
}

/** A model call belongs to the agent run when the scenario text is one of its user turns. */
function isAgentCall(messages: Array<{ role: string; content: any }>, current: string): boolean {
    if (!current) return false
    // 2.89.3: the pipeline may hand the model only part of the request (a part without a tool is closed honestly
    // before the model runs) - that part is the beginning of what the user wrote.
    return messages.some(message => {
        if (message.role !== 'user') return false
        const text = messageText(message.content)
        return text.includes(current) || (text.trim().length >= 8 && current.startsWith(text.trim()))
    })
}

/** The one fake: a model that follows a script and records what it was offered. */
export class ScriptedModel {
    readonly modelId = 'e2e-scripted-model'
    readonly providerId = 'local'
    readonly provider = 'local'
    calls: LlmCall[] = []
    current = ''
    private script: ScriptStep[] = []
    private turnFallback: string | undefined
    constructor(private fallbackText: string) {}
    load(content: string, steps: ScriptStep[], fallback?: string): void {
        this.current = content
        this.script = [...steps]
        this.turnFallback = fallback
    }
    get remaining(): number { return this.script.length }
    async runtimeModelIdentity() { return { model: this.modelId, provider: this.providerId } }
    async complete(messages: any[], tools: any[] = [], options: Record<string, unknown> = {}): Promise<any> {
        const offered = (tools || []).map((tool: any) => String(tool?.name || tool?.function?.name || ''))
        const scripted = isAgentCall(messages || [], this.current)
        const call: LlmCall = { index: this.calls.length, tools: offered, messages: messages || [], options, scripted }
        this.calls.push(call)
        if (!scripted) return { content: this.fallbackText, toolCalls: [], finishReason: 'stop' }
        let step: ScriptStep | undefined = this.script.shift()
        if (!step) return stepToResponse({ text: this.turnFallback ?? this.fallbackText }, call.index)
        for (let guard = 0; guard < 8; guard++) {
            if (typeof step === 'function') { step = await step(call); continue }
            if ('delayMs' in step) {
                const delayed: { delayMs: number; then: ScriptStep } = step
                await new Promise(resolve => setTimeout(resolve, delayed.delayMs))
                step = delayed.then
                continue
            }
            break
        }
        return stepToResponse(step as any, call.index)
    }
    async chat(messages: any[], tools?: any[], options?: Record<string, unknown>) { return this.complete(messages, tools, options) }
}

export interface TurnOptions {
    /** Answer once the script is exhausted (default: harness fallback). */
    fallback?: string
}

export interface E2EHarness {
    root: string
    model: ScriptedModel
    state: any
    entry: (...args: any[]) => Promise<any>
    blockedRequests: string[]
    /** Owner notices of the mission engine (notifyFn). */
    notices: string[]
    telegram(text: string, script?: ScriptStep[], opts?: TurnOptions & { from?: string; chatId?: string }): Promise<TurnResult>
    desktop(text: string, script?: ScriptStep[], opts?: TurnOptions & { timeoutMs?: number }): Promise<TurnResult>
    /** Through the real REST server; `probe` sends the rollout-probe header (X-Xaventra-Probe: 1). */
    rest(text: string, script?: ScriptStep[], opts?: TurnOptions & { probe?: boolean }): Promise<TurnResult>
    /** Several messages at the same time (one capture), e.g. a burst that coalesces. */
    burst(items: Array<{ channel: string; from: string; text: string; messageContext?: any; delayMs?: number }>, script?: ScriptStep[]): Promise<TurnResult>
    /** Any other channel exactly as the daemon entry receives it. */
    send(channel: string, from: string, text: string, script?: ScriptStep[], extra?: TurnOptions & { messageContext?: any; image?: any; execution?: any }): Promise<TurnResult>
    /** Import a module of the SAME module graph the harness runs on (path relative to src/). */
    module<T = any>(srcPath: string): Promise<T>
    close(): Promise<void>
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: 'e2e-scripted-model',
        provider: 'local',
        channels: {
            telegram: { enabled: false, token: '', allowFrom: [OWNER_TELEGRAM_ID] },
            whatsapp: { enabled: false }, discord: { enabled: false }, cli: { enabled: false },
        },
        dashboard: { enabled: false, port: 0 },
        ...extra,
    }
}

function jsonResponse(body: { status?: number; json?: unknown; text?: string }): Response {
    const status = body.status ?? 200
    const payload = body.json !== undefined ? JSON.stringify(body.json) : body.text ?? ''
    return new Response(payload, { status, headers: { 'content-type': body.json !== undefined ? 'application/json' : 'text/plain' } })
}

/** A paused project (Auftrag) of the owner — what /aktivitaet shows with a stop button. */
export function seedPausedAuftrag(root: string, goal = 'Gartenplan fertig machen'): string {
    const id = 'auftrag-e2e-1'
    const mission = {
        id, goal, summary: goal, currentStep: 0, status: 'paused', createdBy: OWNER_TELEGRAM_ID, channel: 'Telegram',
        createdAt: Date.now() - 60_000, progressUpdates: [],
        steps: [{ id: 1, description: 'Beete planen', command: 'Plane die Beete', status: 'pending', retries: 0 }],
    }
    writeFileSync(join(root, '.nova-data', 'auftraege.json'), JSON.stringify({ active: mission, queue: [], history: [] }, null, 2))
    return id
}

function resetProcessGlobals(): void {
    const scope = globalThis as any
    for (const key of Object.keys(scope)) if (key.startsWith('onboarding:')) delete scope[key]
    delete scope.__novaLastMsg
}

export async function createE2EHarness(options: HarnessOptions = {}): Promise<E2EHarness> {
    const projectRoot = process.env.NOVA_PROJECT_ROOT || process.cwd()
    const previousCwd = process.cwd()
    const previousEnv: Record<string, string | undefined> = {}
    for (const key of [...LIVE_UNSET, ...TEST_SWITCHES, 'NOVA_RUNTIME_ROOT', 'NOVA_API_TOKEN']) previousEnv[key] = process.env[key]
    const root = options.reuseRoot || mkdtempSync(join(tmpdir(), 'xv-e2e-'))
    for (const dir of ['.nova-data', '.nova-learning', '.nova-test-tmp']) mkdirSync(join(root, dir), { recursive: true })
    const config = baseConfig(options.config)
    writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(config, null, 2))
    for (const file of [...(options.noSoul ? [] : ['SOUL.md']), 'USER.md', 'package.json']) {
        if (existsSync(join(projectRoot, file))) cpSync(join(projectRoot, file), join(root, file))
    }
    process.env.NOVA_RUNTIME_ROOT = root
    process.env.NOVA_API_TOKEN = REST_TOKEN
    for (const key of LIVE_UNSET) delete process.env[key]
    if (options.searxng) process.env.NOVA_SEARXNG_URL = SEARXNG_URL
    process.chdir(root)
    await options.seed?.(root)

    // Closed network: nothing in a scenario may reach a real system.
    const routes: EnvironmentRoute[] = [...(options.routes || [])]
    if (options.searxng) routes.push({
        match: /^http:\/\/searxng\.example\.com\/search\?/,
        respond: url => ({ json: { query: new URL(url).searchParams.get('q'), results: [
            { title: 'Wanderweg A', url: 'https://example.com/a', content: 'Rundweg, 12 km, leicht.' },
            { title: 'Wanderweg B', url: 'https://example.com/b', content: 'Gipfelweg, 18 km, mittel.' },
        ] } }),
    })
    const realFetch = globalThis.fetch
    const blockedRequests: string[] = []
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : String(input?.url || input)
        const route = routes.find(candidate => candidate.match.test(url))
        if (route) return jsonResponse(route.respond(url, init))
        blockedRequests.push(url)
        throw new TypeError(`fetch failed (e2e harness: network closed for ${url.slice(0, 80)})`)
    }) as typeof fetch

    // Raw TCP/UDP too (HA/Proxmox clients, LAN probes, mDNS): only loopback stays reachable.
    const realConnect = net.Socket.prototype.connect
    const realSend = dgram.Socket.prototype.send
    net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
        const first = args[0]
        const opts = Array.isArray(first) ? first[0] : typeof first === 'object' && first ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
        const host = String(opts?.host ?? 'localhost').replace(/^\[|\]$/g, '')
        if (opts?.path || /^(?:127\.|::1$|localhost$)/i.test(host)) return (realConnect as any).apply(this, args)
        blockedRequests.push(`tcp://${host}:${opts?.port ?? ''}`)
        process.nextTick(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host} (e2e harness: network closed)`), { code: 'ECONNREFUSED' })))
        return this
    } as any
    dgram.Socket.prototype.send = function (this: dgram.Socket, ...args: any[]) {
        blockedRequests.push('udp')
        const callback = [...args].reverse().find(arg => typeof arg === 'function')
        if (callback) process.nextTick(() => callback(Object.assign(new Error('send ENETUNREACH (e2e harness: network closed)'), { code: 'ENETUNREACH' })))
    } as any

    // Process-global pipeline state survives vi.resetModules (onboarding phase, coalescing clock).
    resetProcessGlobals()
    vi.resetModules()
    const src = (path: string) => import(/* @vite-ignore */ `../../src/${path}`)
    const model = new ScriptedModel(options.fallbackText ?? 'Erledigt.')
    const { getToolRegistry } = await src('tools/complete-registry.js')
    const state: any = {
        config, llm: model, tools: getToolRegistry(),
        channels: { telegram: null, whatsapp: null, discord: null },
        startTime: Date.now(),
    }
    ;(globalThis as any).__novaState = state

    // Telegram transport: the real adapter object; its network methods record.
    let buttonLog: Array<{ to: string; text: string; keyboard: unknown }> = []
    const { createTelegramAdapter } = await src('channels/telegram.js')
    const adapter: any = createTelegramAdapter({ token: '1:' + 'x'.repeat(20), allowFrom: [OWNER_TELEGRAM_ID] } as any)
    adapter.sendWithButtons = async (to: string, text: string, keyboard: unknown) => { buttonLog.push({ to: String(to), text, keyboard }); return { ok: true } }
    adapter.send = async () => ({ ok: true })
    adapter.sendMessage = adapter.send
    adapter.sendPhoto = async () => ({ ok: true })
    adapter.stopTyping = () => undefined
    adapter.startTyping = () => undefined
    adapter.getOwnerChatIds = () => [OWNER_TELEGRAM_ID]
    state.channels.telegram = adapter

    const { handleMessage: pipeline } = await src('core/message-pipeline.js')
    const { createDaemonMessageEntry } = await src('core/daemon-message-entry.js')
    const { handleCommand } = await src('core/slash-commands.js')

    // Daemon start-up wiring the pipeline relies on (daemon.ts order).
    const notices: string[] = []
    const { registerConnectionDocks } = await src('connections/connection-docks.js')
    registerConnectionDocks()
    if (options.searxng) {
        const { registerConnectionSource } = await src('connections/connections-view.js')
        registerConnectionSource({ id: 'e2e-umgebung', list: () => [{
            id: `lokal:searxng@${SEARXNG_URL}`, title: 'SearXNG auf diesem Rechner', kategorie: 'hilfsdienste',
            wirkung: 'Private Websuche ohne Key', fund: 'auf diesem Rechner', datenklasse: 'lokal', icon: null, verbunden: true,
        }] })
    }
    const decisions = await src('core/decisions.js')
    await decisions.startDecisionMemory({ nodeOnly: false })
    // This harness is the Main (the lease itself is mesh infrastructure, not under test).
    decisions._setDecisionMainCheckForTest(() => true)
    const { initMissionEngine } = await src('core/autonomous-executor.js')
    initMissionEngine({ handleMessage: pipeline, notifyFn: async (message: string) => { notices.push(message) }, llm: model, state })
    const { getLearningCoordinator } = await src('learning/learning-coordinator.js')
    state.learningCoordinator = getLearningCoordinator()

    const entry = createDaemonMessageEntry({
        pipeline,
        getState: () => state,
        handleCommand: (cmd: string, args: string, from: string, context?: any) => handleCommand(cmd, args, from, state, [], context),
    })
    const mu = await src('users/multi-user-middleware.js')

    async function turn(content: string, script: ScriptStep[], fallback: string | undefined, run: (reply: (text: string) => Promise<void>) => Promise<any>): Promise<TurnResult> {
        model.load(content, script, fallback)
        const startCalls = model.calls.length
        const replies: string[] = []
        buttonLog = []
        const logs: string[] = []
        const original = { log: console.log, debug: console.debug, warn: console.warn, info: console.info, error: console.error }
        const capture = (kind: keyof typeof original) => (...args: any[]) => {
            logs.push(args.map(arg => typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg) } catch { return String(arg) } })()).join(' '))
            if (process.env.E2E_VERBOSE === '1') original[kind](...args)
        }
        console.log = capture('log'); console.debug = capture('debug'); console.warn = capture('warn'); console.info = capture('info'); console.error = capture('error')
        const switches: Record<string, string | undefined> = {}
        if (options.liveProfile !== false) for (const key of TEST_SWITCHES) { switches[key] = process.env[key]; delete process.env[key] }
        const started = Date.now()
        let error: unknown
        let outcome: any
        try {
            outcome = await run(async text => { replies.push(String(text)) })
        } catch (caught) {
            error = caught
        } finally {
            for (const [key, value] of Object.entries(switches)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
            Object.assign(console, original)
        }
        const calls = model.calls.slice(startCalls)
        const rounds = calls.filter(call => call.scripted)
        const trace = logs.map(line => line.match(/^\[Trace:[^\]]+\]\[\+\d+ms\] (.+)$/)?.[1]).filter((step): step is string => Boolean(step))
        const executedTools = logs.flatMap(line => {
            const match = line.match(/^\[Nova Agent\] Tool call: ([A-Za-z0-9_.-]+)/)
            return match ? [match[1]] : []
        })
        return {
            replies, final: replies.at(-1) || '', buttons: buttonLog, calls, rounds,
            offeredTools: rounds[0]?.tools || [], executedTools, trace, logs, outcome, error, durationMs: Date.now() - started,
        }
    }

    const harness: E2EHarness = {
        root, model, state, entry: entry as any, blockedRequests, notices,
        send(channel, from, text, script = [], extra = {}) {
            return turn(text, script, extra.fallback, reply => entry(channel, from, text, reply, extra.image, extra.execution, extra.messageContext))
        },
        burst(items, script = []) {
            return turn(items.at(-1)?.text || '', script, undefined, reply => Promise.all(items.map(async item => {
                if (item.delayMs) await new Promise(resolve => setTimeout(resolve, item.delayMs))
                return entry(item.channel, item.from, item.text, reply, undefined, undefined, item.messageContext)
            })))
        },
        telegram(text, script = [], opts = {}) {
            const from = opts.from || OWNER_TELEGRAM_ID
            // daemon-channels.ts startTelegram: messageHandler('Telegram', msg.from, …, msg.image, undefined, { chatId })
            return harness.send('Telegram', from, text, script, { ...opts, messageContext: { chatId: opts.chatId || from } })
        },
        async desktop(text, script = [], opts = {}) {
            // desktop-api.ts POST /api/desktop/rooms/:id/messages (owner token) → runWithDesktopAgentContext
            // → dashboard handler (daemon-channels setNovaMessageHandler) → messageHandler('desktop', authorizationUserId, …)
            const authorizationUserId = `desktop:${DESKTOP_OWNER}`
            mu.getOrCreateUser(authorizationUserId, 'desktop', DESKTOP_OWNER)
            mu.setUserPermission(authorizationUserId, 'owner')
            const { runWithDesktopAgentContext } = await src('desktop/desktop-agent-context.js')
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(new Error('desktop bot timeout')), opts.timeoutMs ?? 600_000)
            let outcome: any
            try {
                const result = await turn(text, script, opts.fallback, async reply => {
                    // setNovaMessageHandler collects every partial reply into one response.
                    let response = ''
                    await runWithDesktopAgentContext({
                        abortSignal: controller.signal, principalId: DESKTOP_OWNER, clientId: 'e2e-client',
                        authorizationUserId, roomId: 'room-e2e', botId: 'nova', preferredNodeIds: [], modelMode: 'auto',
                        onOutcome: (value: any) => { outcome = value },
                    }, () => entry('desktop', authorizationUserId, text, async (message: string) => {
                        response = response ? `${response}\n\n${message}` : message
                        await reply(message)
                    }))
                    return response
                })
                result.outcome = outcome
                return result
            } finally { clearTimeout(timer) }
        },
        async rest(text, script = [], opts = {}) {
            // 2.89: the REAL REST server (rest-api.ts) on a loopback port, as daemon.ts wires it:
            // POST /v1/message with the bearer token → token principal, owner grant, daemon entry.
            const { startRestApi } = await src('server/rest-api.js')
            const server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' },
                (channel: string, from: string, content: string, reply: (text: string) => Promise<void>) => entry(channel, from, content, reply),
                () => ({ version: 'e2e' }))
            try {
                return await turn(text, script, opts.fallback, async reply => {
                    const port = (server.address() as net.AddressInfo).port
                    const response = await realFetch(`http://127.0.0.1:${port}/v1/message`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json', ...(opts.probe ? { 'X-Xaventra-Probe': '1' } : {}) },
                        body: JSON.stringify({ content: text }),
                    })
                    const body: any = await response.json()
                    if (!response.ok) throw new Error(`REST ${response.status}: ${body?.error || ''}`)
                    if (body?.response) await reply(String(body.response))
                    return body
                })
            } finally {
                await new Promise(resolve => server.close(() => resolve(undefined)))
            }
        },
        module: (path: string) => src(path),
        async close() {
            globalThis.fetch = realFetch
            net.Socket.prototype.connect = realConnect
            dgram.Socket.prototype.send = realSend
            try { (await src('core/projects-runtime.js')).setProjectCoordinator?.(null) } catch { /* optional */ }
            try { (await src('connections/connection-docks.js')).unregisterConnectionDocks?.() } catch { /* optional */ }
            try { (await src('connections/connections-view.js')).unregisterConnectionSource?.('e2e-umgebung') } catch { /* optional */ }
            try { (await src('core/decisions.js'))._setDecisionMainCheckForTest?.(null) } catch { /* optional */ }
            resetProcessGlobals()
            delete (globalThis as any).__novaState
            process.chdir(previousCwd)
            for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
            if (!options.keepRoot) try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows may keep a handle on a temp dir */ }
        },
    }
    return harness
}

/** Texts that must never reach a user: raw tool dumps, catalogs, the incomplete marker. */
export const FORBIDDEN_REPLY_PATTERNS: RegExp[] = [
    /Die Aufgabe ist (noch )?nicht (vollständig )?(abgeschlossen|ausgewertet)/i,
    /Bisherige Tool-Beobachtungen/i,
    /zu viele Zwischenschritte/i,
    /konnte keine Antwort generieren/i,
    /Tool-Katalog|Werkzeugkatalog/i,
    /"name"\s*:\s*"[a-z_]+"\s*,\s*"description"/i,
    /\[object Object\]/,
]

export function rawOrCatalogLeak(text: string): RegExp | undefined {
    return FORBIDDEN_REPLY_PATTERNS.find(pattern => pattern.test(text))
}
