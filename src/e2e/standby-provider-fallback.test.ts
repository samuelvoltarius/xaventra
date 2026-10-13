/**
 * 2.89.7: a Standby-Main without the Main GPU. Its configured local model runs on another node
 * (providers.local.baseUrl = a remote vLLM). When that node is gone the answer must come from the
 * owner's self-registered OpenAI-compatible provider (register_llm_provider: baseUrl + sealed vault key),
 * explicitly listed in fallbackModels - without a minutes-long hang, without leaking the key, and back to
 * the local model once the endpoint returns.
 *
 * Path under test: the real daemon entry -> message pipeline -> agent runner -> the REAL llm-factory wrapper
 * (createLLM) -> model fallback chain -> local SDK provider. Only the network is simulated: the remote vLLM
 * host (192.0.2.10, a documentation address) either drops packets (a powered-off node, never "refused") or
 * answers; the registered provider (api.acme.example) records what it receives.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

const FAKE_KEY = 'fake-acme-key-' + 'z'.repeat(26)
const REMOTE = 'http://192.0.2.10:8000/v1'
const ACME = 'https://api.acme.example/v1'

interface Net {
    remoteAlive: boolean
    remoteRequests: string[]
    acmeRequests: Array<{ url: string; authorization: string; body: string }>
}

const completion = (text: string) => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
}), { status: 200, headers: { 'content-type': 'application/json' } })

interface Options { fallbackModels: string[]; registered?: Record<string, unknown> | null; storeKey?: boolean }

async function standby(options: Options): Promise<{ h: E2EHarness; net: Net; llm: any; sdk: any }> {
    const registered = options.registered === undefined
        ? { name: 'acme', apiKey: '', apiKeyRef: 'auth:llm-provider:acme', baseUrl: ACME, models: ['acme-chat-pro'], enabled: true, addedAt: 1 }
        : options.registered
    h = await createE2EHarness({
        config: {
            provider: 'local', model: 'qwen-remote',
            providers: { local: { baseUrl: REMOTE, enabled: true }, acme: { apiKeyRef: 'auth:llm-provider:acme', baseUrl: ACME, enabled: true } },
            fallbackModels: options.fallbackModels,
        },
        seed: root => { if (registered) writeFileSync(join(root, '.nova-data', 'external-providers.json'), JSON.stringify([registered], null, 2)) },
    })
    if (options.storeKey !== false) (await h.module('secrets/provider-keys.js')).storeProviderKey('acme', FAKE_KEY)

    const net: Net = { remoteAlive: false, remoteRequests: [], acmeRequests: [] }
    const harnessFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : String(input?.url || input)
        if (url.startsWith('http://192.0.2.10:8000')) {
            net.remoteRequests.push(url)
            if (!net.remoteAlive) {
                // A node that is switched off: no answer, no refusal - only the caller's deadline ends it.
                return new Promise<Response>((_resolve, reject) => {
                    const signal: AbortSignal | undefined = init?.signal
                    if (signal?.aborted) return reject(signal.reason)
                    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            }
            return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'qwen-remote' }] }), { status: 200 }) : completion('Antwort vom lokalen Modell')
        }
        if (url.startsWith('https://api.acme.example')) {
            const headers = new Headers(init?.headers || {})
            net.acmeRequests.push({ url, authorization: headers.get('authorization') || '', body: String(init?.body || '') })
            return completion('Antwort vom registrierten Anbieter')
        }
        return harnessFetch(input, init)
    }) as typeof fetch

    const factory = await h.module('core/llm-factory.js')
    factory.availableLLMs.length = 0
    factory.availableLLMs.push({ provider: 'local', model: 'qwen-remote', local: true, endpoint: REMOTE })
    const sdk = await h.module('llm/nova-llm-sdk.js')
    sdk.resetServerHealthForTests()
    const llm = await factory.createLLM({ provider: 'local', model: 'qwen-remote' })
    h.state.llm = llm
    return { h, net, llm, sdk }
}

/** Milliseconds between two trace steps of a turn (independent of one-time module warm-up). */
function between(logs: string[], from: string, to: string): number {
    const at = (step: string): number => {
        const line = logs.find(entry => /^\[Trace:[^\]]+\]\[\+\d+ms\] (\S+)$/.exec(entry)?.[1] === step)
        return Number(line?.match(/\[\+(\d+)ms\]/)?.[1] ?? NaN)
    }
    return at(to) - at(from)
}

function plaintextHits(root: string): string[] {
    const hits: string[] = []
    const scan = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry)
            if (statSync(path).isDirectory()) scan(path)
            else { try { if (readFileSync(path).includes(FAKE_KEY)) hits.push(path.slice(root.length)) } catch { /* unreadable */ } }
        }
    }
    scan(root)
    return hits
}

describe('2.89.7 standby main: registered provider as fallback when the remote local node is gone', () => {
    it('answers via the registered provider with the vault key, fast, and does not wait again on the next message', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const first = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(first.error).toBeUndefined()
        expect(first.final).toContain('Antwort vom registrierten Anbieter')
        // Not minutes: the probe decides within its 4 s, the cloud answers at once (the old path waited 45-55 s).
        const modelPhase = between(first.logs, 'agent:start', 'pipeline:complete')
        expect(modelPhase).toBeGreaterThan(0)
        expect(modelPhase).toBeLessThan(10_000)
        // Only the registered provider's own endpoint got the call, with the vault key as bearer token.
        const chat = ctx.net.acmeRequests.filter(request => !request.url.endsWith('/models')) // the reachability probe carries no key
        expect(chat.length).toBeGreaterThan(0)
        for (const request of chat) {
            expect(request.url).toBe(`${ACME}/chat/completions`)
            expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`)
            expect(JSON.parse(request.body).model).toBe('acme-chat-pro')
        }
        // The dead node never got a completion request - only the reachability probe.
        expect(ctx.net.remoteRequests.every(url => url.endsWith('/models'))).toBe(true)

        // Remembered: the next message does not wait on the dead endpoint again.
        const remoteBefore = ctx.net.remoteRequests.length
        const second = await ctx.h.telegram('Und morgen?')
        expect(second.error).toBeUndefined()
        expect(second.final).toContain('Antwort vom registrierten Anbieter')
        expect(between(second.logs, 'agent:start', 'pipeline:complete')).toBeLessThan(2_000)
        // Nothing but (at most) one background recovery probe went to the dead node.
        expect(ctx.net.remoteRequests.slice(remoteBefore).every(url => url.endsWith('/models'))).toBe(true)
        expect(ctx.net.remoteRequests.slice(remoteBefore).length).toBeLessThanOrEqual(1)
    }, T)

    it('never lets the key into logs, replies, the sent prompt, or any file in clear text', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom registrierten Anbieter')
        expect(turn.logs.join('\n')).not.toContain(FAKE_KEY)
        expect(turn.replies.join('\n')).not.toContain(FAKE_KEY)
        for (const request of ctx.net.acmeRequests) expect(request.body).not.toContain(FAKE_KEY)
        const history = JSON.stringify(ctx.h.state)
        expect(history).not.toContain(FAKE_KEY)
        expect(plaintextHits(ctx.h.root)).toEqual([])
    }, T)

    it('uses no cloud when the model is not listed in fallbackModels', async () => {
        const ctx = await standby({ fallbackModels: [] })
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(ctx.net.acmeRequests).toEqual([])
        expect(turn.final).not.toContain('Antwort vom registrierten Anbieter')
        expect(turn.final.length).toBeGreaterThan(0) // an honest failure message, never silence
        expect(ctx.h.blockedRequests.filter(url => url.includes('acme.example'))).toEqual([])
    }, T)

    it('goes back to the local model once the endpoint answers again', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const down = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(down.final).toContain('Antwort vom registrierten Anbieter')
        expect(ctx.sdk.isServerUnreachable(REMOTE)).toBe(true)

        // The node comes back; the background recovery check (rate-limited per 15 s) notices it.
        ctx.net.remoteAlive = true
        expect(await ctx.sdk.scheduleRecoveryProbe(REMOTE, Date.now() + 16_000)).toBe(true)
        expect(ctx.sdk.isServerUnreachable(REMOTE)).toBe(false)

        const acmeBefore = ctx.net.acmeRequests.length
        const up = await ctx.h.telegram('Und jetzt?')
        expect(up.error).toBeUndefined()
        expect(up.final).toContain('Antwort vom lokalen Modell')
        expect(ctx.net.acmeRequests.length).toBe(acmeBefore)
    }, T)
})

describe('2.89.7 configuredCloudFallbacks with registered providers', () => {
    const route = async (options: Options) => {
        const ctx = await standby(options)
        return (await ctx.h.module('core/llm-factory.js')).configuredCloudFallbacks()
    }
    const entry = (patch: Record<string, unknown>) => ({ name: 'acme', apiKey: '', apiKeyRef: 'auth:llm-provider:acme', baseUrl: ACME, models: ['acme-chat-pro'], enabled: true, addedAt: 1, ...patch })

    it('lists an explicitly named model of an enabled registered provider', async () => {
        expect(await route({ fallbackModels: ['acme-chat-pro'] })).toEqual([{ provider: 'acme', model: 'acme-chat-pro' }])
    }, T)

    it('never widens the list: a model the provider also serves is not added unless named', async () => {
        expect(await route({ fallbackModels: ['something-else'], registered: entry({ models: ['acme-chat-pro', 'acme-chat-lite'] }) })).toEqual([])
    }, T)

    it('has no candidate without a vault key', async () => {
        expect(await route({ fallbackModels: ['acme-chat-pro'], storeKey: false })).toEqual([])
    }, T)

    it('has no candidate for a disabled provider or a model outside its list', async () => {
        expect(await route({ fallbackModels: ['acme-chat-pro'], registered: entry({ enabled: false }) })).toEqual([])
    }, T)

    it('has no candidate when the provider does not list the model', async () => {
        expect(await route({ fallbackModels: ['acme-chat-pro'], registered: entry({ models: ['acme-chat-lite'] }) })).toEqual([])
    }, T)

    it('ignores a registered name that would take over a built-in route', async () => {
        expect(await route({ fallbackModels: ['acme-chat-pro'], registered: entry({ name: 'openai' }) })).toEqual([])
    }, T)
})

describe('2.89.7 internal calls with a dead local endpoint never block the main answer', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user', content: `Nachricht ${i}: der Server mit 192.0.2.${i + 1} wurde heute neu gestartet`, timestamp: i,
    }))

    it('the foreground session summary is extractive and never calls a model', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const { processSessionForLLM } = await ctx.h.module('layers/L6-session-summary.js')
        const started = Date.now()
        const result = await processSessionForLLM('u-standby-1', 'Telegram', history, 12000, false)
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(result.hotMessages.length).toBeGreaterThan(0)
        expect(ctx.net.remoteRequests).toEqual([])
        expect(ctx.net.acmeRequests).toEqual([])
    }, T)

    it('the background summary gives up within its 8 s cap (plus probe) and falls back to the extractive text', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const { summarizeMessages } = await ctx.h.module('layers/L6-session-summary.js')
        const started = Date.now()
        const summary = await summarizeMessages(history.map(({ role, content }) => ({ role, content })))
        expect(Date.now() - started).toBeLessThan(10_000)
        expect(summary.length).toBeGreaterThan(0)
        // Never a completion request to the dead node: at most the reachability probe.
        expect(ctx.net.remoteRequests.every(url => url.endsWith('/models'))).toBe(true)
        // The held endpoint makes the next internal call immediate.
        const again = Date.now()
        await summarizeMessages(history.map(({ role, content }) => ({ role, content })))
        expect(Date.now() - again).toBeLessThan(2_000)
    }, T)

    it('a main answer is not delayed by a parallel background summary on the dead endpoint', async () => {
        const ctx = await standby({ fallbackModels: ['acme-chat-pro'] })
        const { summarizeMessages } = await ctx.h.module('layers/L6-session-summary.js')
        const background = summarizeMessages(history.map(({ role, content }) => ({ role, content })))
        const turn = await ctx.h.telegram('Wie ist das Wetter in Salzburg?')
        expect(turn.final).toContain('Antwort vom registrierten Anbieter')
        expect(between(turn.logs, 'agent:start', 'pipeline:complete')).toBeLessThan(10_000)
        await background
    }, T)
})
