/**
 * 2.89.3 (live 08.10.2026): an offline tailnet Ollama (100.73.189.71:11434, three models) was asked on
 * every call, and the machine's own vLLM was asked again under "localhost" after it had timed out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNovaLLMClient, isConnectionFailure, isServerUnreachable, markServerUnreachable, resetServerHealthForTests } from './nova-llm-sdk.js'
import { availableLLMs } from '../core/llm-factory.js'

beforeEach(() => {
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
    vi.stubEnv('NOVA_OS_MODE', 'false')
    resetServerHealthForTests()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); availableLLMs.splice(0); resetServerHealthForTests() })

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

describe('server health for local model calls', () => {
    it('classifies "did not answer at all" apart from slow or failing models', () => {
        expect(isConnectionFailure('fetch failed')).toBe(true)
        expect(isConnectionFailure('connect ECONNREFUSED 100.73.189.71:11434')).toBe(true)
        expect(isConnectionFailure('The operation was aborted due to timeout')).toBe(false)
        expect(isConnectionFailure('LLM API error (500): boom')).toBe(false)
    })

    it('an unreachable server is skipped for 5 minutes, then tried again', () => {
        const now = Date.now()
        markServerUnreachable('http://100.73.189.71:11434', now)
        expect(isServerUnreachable('http://100.73.189.71:11434', now + 4 * 60_000)).toBe(true)
        expect(isServerUnreachable('http://100.73.189.71:8000', now + 1000)).toBe(false)
        expect(isServerUnreachable('http://100.73.189.71:11434', now + 5 * 60_000 + 1)).toBe(false)
    })

    it('one dead server costs one request, not one per model; the next call does not ask it at all', async () => {
        availableLLMs.push(
            { model: 'm-a', endpoint: 'http://dead.test:11434', local: true, provider: 'ollama' } as any,
            { model: 'm-b', endpoint: 'http://dead.test:11434', local: true, provider: 'ollama' } as any,
            { model: 'm-c', endpoint: 'http://dead.test:11434', local: true, provider: 'ollama' } as any,
            { model: 'live-model', endpoint: 'http://live.test:8000', local: true, provider: 'vllm' } as any,
        )
        const urls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            urls.push(String(url))
            if (String(url).includes('dead.test')) throw refused()
            return ok()
        }))
        const client = await createNovaLLMClient({ provider: 'local', model: 'm-a', baseUrl: 'http://dead.test:11434' })
        expect((await client.complete([{ role: 'user', content: 'hi' }])).content).toBe('OK')
        expect(urls.filter(url => url.includes('dead.test'))).toHaveLength(1)
        urls.length = 0
        expect((await client.complete([{ role: 'user', content: 'again' }])).content).toBe('OK')
        expect(urls.filter(url => url.includes('dead.test'))).toHaveLength(0)
        expect(urls).toHaveLength(1)
    })

    it('a model that timed out is not asked again on the same server under another address', async () => {
        availableLLMs.push({ model: 'slow-model', endpoint: 'http://localhost:8000', local: true, provider: 'vllm' } as any)
        const urls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            urls.push(String(url))
            throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        }))
        const client = await createNovaLLMClient({ provider: 'local', model: 'slow-model', baseUrl: 'http://127.0.0.1:8000/v1' })
        await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/timeout/)
        expect(urls).toHaveLength(1)
    })
})
