import { describe, expect, it } from 'vitest'
import { formatEndpointSection } from './status-endpoints.js'

// 2.82.0 (DOPPELUNGEN Gruppe 2): /status called the local LLM endpoints
// "Mesh (N Nodes)". They are endpoints, not mesh nodes; the real node list
// comes from the capability graph.

const entries = [
    { provider: 'local', model: 'qwen', local: true, endpoint: 'http://localhost:8000', nodeName: 'spark vllm' },
    { provider: 'local', model: 'llama3', local: true, endpoint: 'http://198.51.100.7:11434', nodeName: 'ns1 ollama' },
    { provider: 'local', model: 'nomic-embed-text', local: true, endpoint: 'http://198.51.100.7:11434', nodeName: 'ns1 ollama' },
    { provider: 'openai', model: 'gpt-x', local: false },
]
const nodes = [
    { id: 'spark', hostname: 'spark', status: 'online' },
    { id: 'ns1', hostname: 'ns1', status: 'online' },
    { id: 'ns2', hostname: 'ns2', status: 'online' },
    { id: 'nas', hostname: 'f6a1c0ffee12', status: 'offline' },
] as any[]

describe('/status: endpoints are not nodes', () => {
    it('heads the endpoint list "KI-Endpunkte (N)" and adds the real node line', () => {
        const text = formatEndpointSection(entries as any, 'qwen', nodes)
        expect(text).toContain('*KI-Endpunkte (2):*')
        expect(text).not.toMatch(/Mesh \(\d+ Nodes\)/)
        expect(text).toContain('★ spark vllm (localhost:8000): qwen')
        expect(text).toContain('○ ns1 ollama (198.51.100.7:11434): llama3')
        expect(text).toContain('☁ Cloud: gpt-x')
        expect(text).toContain('*Knoten (4):* spark, ns1, ns2, nas (offline)')
    })

    it('without graph nodes there is no node line; without anything no section', () => {
        expect(formatEndpointSection(entries as any, 'qwen', [])).not.toContain('Knoten')
        expect(formatEndpointSection([], 'qwen', [])).toBe('')
    })
})
