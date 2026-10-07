import { describe, expect, it } from 'vitest'
import { checkProviders } from './collect.js'

// 2.87.1 (live 07.10.2026): provider "local" with an OpenAI-compatible runtime
// (vLLM) was probed as Ollama on localhost → "Das KI-Programm antwortet nicht"
// while the model answered normally.

const respond = (routes: Record<string, unknown>) => (async (url: any) => {
    const key = Object.keys(routes).find(route => String(url).endsWith(route))
    if (!key) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(routes[key]), { status: 200 })
}) as typeof fetch

describe('doctor: configured local runtime instead of a hard-coded Ollama probe', () => {
    const config = { provider: 'local', providers: { local: { enabled: true, baseUrl: 'http://192.0.2.10:8000' } } }

    it('a reachable vLLM behind providers.local is healthy and never reported as Ollama', async () => {
        const result = await checkProviders(config, { fetch: respond({ '/v1/models': { data: [{ id: 'qwen' }] } }) })
        expect(result.ok).toBe(true)
        expect(result.issues.map(i => i.code)).not.toContain('OLLAMA_UNREACHABLE')
        expect(result.issues.map(i => i.code)).not.toContain('LLM_PROVIDER_NOT_SET')
    })

    it('an unreachable local runtime is reported as the local model, not as Ollama (Gegenprobe)', async () => {
        const result = await checkProviders(config, { fetch: respond({}) })
        expect(result.ok).toBe(false)
        expect(result.issues.map(i => i.code)).toEqual(['LOCAL_LLM_UNREACHABLE'])
    })

    it('provider ollama still probes Ollama', async () => {
        const result = await checkProviders({ provider: 'ollama', ollama: { baseUrl: 'http://192.0.2.11:11434' } }, { fetch: respond({}) })
        expect(result.issues.map(i => i.code)).toContain('OLLAMA_UNREACHABLE')
    })
})
