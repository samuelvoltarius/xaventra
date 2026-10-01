import { describe, expect, it } from 'vitest'
import { dedupeDiscoveryCandidates, sameEndpoint } from './local-llm.js'

// 2.82.0 (DOPPELUNGEN Gruppe 2): the built-in vLLM preset localhost:8000 and
// the config node entry <own tailnet address>:8000 are the same server. Only
// the URL text was compared, so /status showed it twice and the capability
// probe sent every test request twice. Addresses here are RFC 5737 / example.com.

const preset = (baseUrl: string, name = 'vLLM') => ({ name, baseUrl, source: 'preset' as const })
const config = (baseUrl: string, nodeName: string) => ({ name: `${nodeName} vllm`, baseUrl, source: 'config' as const, nodeName })

describe('local LLM discovery: one endpoint, one entry', () => {
    it('a config node that is this machine collapses into the localhost preset and keeps the node name', () => {
        const result = dedupeDiscoveryCandidates([preset('http://localhost:8000'), config('http://192.0.2.10:8000', 'spark')], ['192.0.2.10', '127.0.0.1'])
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({ nodeName: 'spark', source: 'config' })
    })

    it('a remote node with the same port stays separate', () => {
        const result = dedupeDiscoveryCandidates([preset('http://localhost:8000'), config('http://198.51.100.7:8000', 'ns1')], ['192.0.2.10'])
        expect(result.map(item => item.baseUrl)).toEqual(['http://localhost:8000', 'http://198.51.100.7:8000'])
    })

    it('the same endpoint written differently is one entry (host case, loopback aliases)', () => {
        expect(dedupeDiscoveryCandidates([config('http://example.com:8000', 'a'), config('http://EXAMPLE.com:8000', 'b')], [])).toHaveLength(1)
        expect(dedupeDiscoveryCandidates([preset('http://localhost:11434', 'Ollama'), config('http://127.0.0.1:11434', 'main')], [])).toHaveLength(1)
    })

    it('different ports on the same local host stay separate', () => {
        expect(dedupeDiscoveryCandidates([preset('http://localhost:8000'), preset('http://localhost:11434', 'Ollama'), config('http://192.0.2.10:1234', 'spark')], ['192.0.2.10'])).toHaveLength(3)
    })

    it('AIScan uses the same identity: its local port scan and the config node are one endpoint', () => {
        expect(sameEndpoint('http://localhost:8000', 'http://192.0.2.10:8000', ['192.0.2.10'])).toBe(true)
        expect(sameEndpoint('http://localhost:8000', 'http://198.51.100.7:8000', ['192.0.2.10'])).toBe(false)
        expect(sameEndpoint('http://localhost:8000', 'http://localhost:11434', [])).toBe(false)
    })
})
