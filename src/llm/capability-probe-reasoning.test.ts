import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeModel, PROBE_ANSWER_TOKENS } from './capability-probe.js'

// Live 30.09.2026: the Spark vLLM (a reasoning model) reads images correctly but
// answered the vision probe with content=null at max_tokens 15 (finish_reason
// "length"), so Nova reported "kein Provider für vision" to the user.

// A reasoning model: it thinks first; the visible answer only appears when the
// budget leaves room after about 60 reasoning tokens.
function reasoningModel(url: string, init: any) {
    const body = JSON.parse(init?.body || '{}')
    const text = JSON.stringify(body.messages || [])
    const budget = Number(body.max_tokens || 0)
    const answer = /image_url/.test(text) ? 'Red'
        : /function named add/.test(text) ? 'function add(a, b) { return a + b }'
        : /youngest/.test(text) ? 'Max'
        : 'ok'
    const thinking = /image_url/.test(text) ? 'The image is a solid red square, so the colour is red.' : 'Let me think step by step.'
    const room = budget >= 100
    const message: any = { role: 'assistant', content: room ? answer : null, reasoning: thinking }
    if (body.tools) return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: '1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] } }] }), { status: 200 })
    return new Response(JSON.stringify({ choices: [{ finish_reason: room ? 'stop' : 'length', message }], usage: { completion_tokens: 10 } }), { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe('capability probe with reasoning models', () => {
    it('gives the answer probes enough budget for thinking first', () => {
        expect(PROBE_ANSWER_TOKENS).toBeGreaterThanOrEqual(256)
    })

    it('detects vision, code and reasoning on a model that thinks before answering', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => reasoningModel(url, init)))
        const result = await probeModel('http://127.0.0.1:8000/v1', 'qwen')
        expect(result.online).toBe(true)
        expect(result.supportsVision).toBe(true)
        expect(result.roles).toEqual(expect.arrayContaining(['vision', 'code', 'reasoning']))
    })

    it('still rejects a model that cannot see the image', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
            const body = JSON.parse(init?.body || '{}')
            if (/image_url/.test(JSON.stringify(body.messages || []))) {
                return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'I cannot view images.', reasoning: 'No image support.' } }] }), { status: 200 })
            }
            return reasoningModel(url, init)
        }))
        const result = await probeModel('http://127.0.0.1:8000/v1', 'qwen')
        expect(result.supportsVision).toBe(false)
        expect(result.roles).not.toContain('vision')
    })
})

describe('capability probe cache', () => {
    // Live 30.09.2026 22:08: after the 2.79.2 fix the Spark still read
    // vision=false for qwen from the v1 cache written by the 15-token probe.
    it('ignores results cached by an older probe version', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
        const probedAt = new Date().toISOString()
        writeFileSync(join(process.cwd(), '.nova-data', 'model-capabilities.json'), JSON.stringify({
            version: 1, lastProbed: probedAt,
            results: { 'http://127.0.0.1:8000|qwen': { endpoint: 'http://127.0.0.1:8000', model: 'qwen', online: true, supportsVision: false, roles: ['chat'], probedAt, lastProbed: probedAt } },
        }))
        vi.resetModules()
        const fresh = await import('./capability-probe.js')
        expect(fresh.PROBE_CACHE_VERSION).toBeGreaterThan(1)
        expect(fresh.getCachedProbe('qwen')).toBeNull()
    })
})
