import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatEndpointSection } from './status-endpoints.js'

// 2.82.0 (DOPPELUNGEN Gruppe 2): /status listed endpoints from `availableLLMs`
// (localhost and the Tailscale IP of the Spark twice, ns2/NAS missing). Now
// endpoints AND nodes come from the one inventory, the capability graph.

const runtime = (type: string, endpoint: string, models: string[], status = 'running') => ({ id: `${type}@${endpoint}`, name: type, type, endpoint, status, models, capabilities: [], verifiedAt: '2026-10-01T10:00:00Z', verificationSource: 'probe' })
const nodes = [
    { id: 'spark', hostname: 'spark', status: 'online', runtimes: [runtime('vllm', 'http://198.51.100.5:8000/v1', ['qwen'])] },
    { id: 'ns1', hostname: 'ns1', status: 'online', runtimes: [runtime('ollama', 'http://198.51.100.7:11434', ['llama3', 'nomic-embed-text']), runtime('lmstudio', 'http://198.51.100.7:1234', ['x'], 'stopped')] },
    { id: 'ns2', hostname: 'ns2', status: 'online', runtimes: [] },
    { id: 'nas', hostname: 'f6a1c0ffee12', status: 'offline', runtimes: [] },
] as any[]

describe('/status: alles aus dem capability-graph', () => {
    it('Endpunkte je Knoten aus den laufenden Runtimes, dazu die Knotenzeile; Cloud separat', () => {
        const text = formatEndpointSection(nodes, 'qwen', ['gpt-x'])
        expect(text).toContain('*KI-Endpunkte (2):*')
        expect(text).toContain('★ spark vllm (198.51.100.5:8000): qwen')
        expect(text).toContain('○ ns1 ollama (198.51.100.7:11434): llama3')
        expect(text).not.toContain('lmstudio')
        expect(text).not.toContain('localhost')
        expect(text).toContain('☁ Cloud: gpt-x')
        expect(text).toContain('*Knoten (4):* spark, ns1, ns2, nas (offline)')
    })

    it('ohne Graph keine Knoten und keine lokalen Endpunkte; ohne alles kein Abschnitt', () => {
        expect(formatEndpointSection([], 'qwen', ['gpt-x'])).not.toContain('Knoten')
        expect(formatEndpointSection([], 'qwen', [])).toBe('')
    })

    it('/status nimmt keine lokalen Endpunkte mehr aus availableLLMs', () => {
        const source = readFileSync(fileURLToPath(new URL('./slash-commands.ts', import.meta.url)), 'utf8')
        const call = source.slice(source.indexOf('formatEndpointSection('), source.indexOf('formatEndpointSection(') + 200)
        expect(call).toMatch(/formatEndpointSection\(graphNodes, configModel, cloudModels\)/)
    })
})
