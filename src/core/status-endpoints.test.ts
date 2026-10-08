import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatEndpointSection } from './status-endpoints.js'
import { NODE_OFFLINE_AFTER_MS } from '../mesh/mesh-node-lifecycle.js'

// 2.82.0 (DOPPELUNGEN Gruppe 2): /status listed endpoints from `availableLLMs`
// (localhost and the Tailscale IP of the Spark twice, ns2/NAS missing). Now
// endpoints AND nodes come from the one inventory, the capability graph.
//
// 2.89.4 (live): /status showed ghost nodes and dead endpoints. The Desktop
// node-list freshness rule and the capability-graph availability checks decide
// what is listed.

const NOW = Date.parse('2026-10-09T12:00:00Z')
const fresh = (offsetMs = -30_000) => new Date(NOW + offsetMs).toISOString()
const stale = () => new Date(NOW - NODE_OFFLINE_AFTER_MS - 60_000).toISOString()

const runtime = (type: string, endpoint: string, models: string[], status = 'running', verifiedAt = fresh(), verificationSource: 'probe' | 'mesh-heartbeat' = 'probe') =>
    ({ id: `${type}@${endpoint}`, name: type, type, endpoint, status, models, capabilities: [], verifiedAt, verificationSource })
const nodes = [
    { id: 'spark', hostname: 'spark', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(), runtimes: [runtime('vllm', 'http://192.0.2.5:8000/v1', ['qwen'])] },
    { id: 'ns1', hostname: 'ns1', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(), runtimes: [runtime('ollama', 'http://192.0.2.7:11434', ['llama3', 'nomic-embed-text']), runtime('lmstudio', 'http://192.0.2.7:1234', ['x'], 'stopped')] },
    { id: 'ns2', hostname: 'ns2', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(), runtimes: [] },
    { id: 'nas', hostname: 'nas', status: 'offline', lastHeartbeat: stale(), updatedAt: stale(), runtimes: [] },
] as any[]

describe('/status: alles aus dem capability-graph', () => {
    it('Endpunkte je Knoten aus den laufenden Runtimes, dazu die Knotenzeile; Cloud separat', () => {
        const text = formatEndpointSection(nodes, 'qwen', ['gpt-x'], { now: NOW, localNodeId: 'main' })
        expect(text).toContain('*KI-Endpunkte (2):*')
        expect(text).toContain('★ spark vllm (192.0.2.5:8000): qwen')
        expect(text).toContain('○ ns1 ollama (192.0.2.7:11434): llama3')
        expect(text).not.toContain('lmstudio')
        expect(text).not.toContain('localhost')
        expect(text).toContain('☁ Cloud: gpt-x')
        expect(text).toContain('*Knoten (4):* spark, ns1, ns2, nas (offline)')
    })

    it('ohne Graph keine Knoten und keine lokalen Endpunkte; ohne alles kein Abschnitt', () => {
        expect(formatEndpointSection([], 'qwen', ['gpt-x'], { now: NOW, localNodeId: 'main' })).not.toContain('Knoten')
        expect(formatEndpointSection([], 'qwen', [], { now: NOW, localNodeId: 'main' })).toBe('')
    })

    it('/status nimmt keine lokalen Endpunkte mehr aus availableLLMs', () => {
        const source = readFileSync(fileURLToPath(new URL('./slash-commands.ts', import.meta.url)), 'utf8')
        const call = source.slice(source.indexOf('formatEndpointSection('), source.indexOf('formatEndpointSection(') + 280)
        expect(call).toMatch(/formatEndpointSection\(graphNodes, configModel, cloudModels, \{ localNodeId, tombstones: graphTombstones \}\)/)
    })
})

// 2.89.4 (live): ghost nodes and dead endpoints in /status.
describe('/status: keine Ghost-Knoten, keine toten Endpunkte', () => {
    it('Desktop-Frischeregel: ein veralteter Heartbeat ist offline, auch bei status=online', () => {
        const ghost = [{ id: 'k8s-deleted', hostname: 'k8s-deleted', status: 'online', lastHeartbeat: stale(), updatedAt: fresh(), runtimes: [] }] as any[]
        const text = formatEndpointSection(ghost, 'qwen', [], { now: NOW, localNodeId: 'main' })
        expect(text).toContain('*Knoten (1):* k8s-deleted (offline)')
    })

    it('keine geratenen Peer-/Scanner-Zeilen ohne Heartbeat (Phantom)', () => {
        const phantom = [
            { id: 'guessed-from-peer', hostname: 'guessed-from-peer', status: 'unknown', updatedAt: fresh(), runtimes: [runtime('vllm', 'http://192.0.2.9:8000', ['qwen'])] },
            { id: 'scanner-host', hostname: 'scanner-host', status: 'unknown', updatedAt: fresh(), runtimes: [] },
        ] as any[]
        const text = formatEndpointSection(phantom, 'qwen', ['gpt-x'], { now: NOW, localNodeId: 'main' })
        expect(text).not.toContain('guessed-from-peer')
        expect(text).not.toContain('scanner-host')
        expect(text).not.toContain('192.0.2.9')
        expect(text).not.toContain('Knoten')
    })

    it('ein laufender, aber nicht erreichbarer Endpunkt wird markiert', () => {
        const dead = [{
            id: 'spark', hostname: 'spark', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(),
            runtimes: [
                runtime('vllm', 'http://192.0.2.5:8000', ['qwen']),
                runtime('ollama', 'http://192.0.2.5:11434', ['llama3'], 'running', stale()),
            ],
        }] as any[]
        const text = formatEndpointSection(dead, 'qwen', [], { now: NOW, localNodeId: 'main' })
        expect(text).toContain('★ spark vllm (192.0.2.5:8000): qwen\n')
        expect(text).toContain('○ spark ollama (192.0.2.5:11434): llama3 — nicht erreichbar')
        expect(text).toContain('*KI-Endpunkte (2):*')
    })

    it('ein beworbener, aber nicht erreichbarer Endpunkt wird markiert (Desktop-Regel)', () => {
        const dead = [{
            id: 'spark', hostname: 'spark', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(),
            software: {
                node_version: 'v22', package_managers: [], can_install: [],
                ai_services: [
                    { name: 'vllm', type: 'llm', endpoint: 'http://192.0.2.5:8000', status: 'running', models: ['qwen'] },
                    { name: 'ollama', type: 'llm', endpoint: 'http://192.0.2.5:11434', status: 'running', models: ['llama3'] },
                ],
            },
            runtimes: [
                runtime('vllm', 'http://192.0.2.5:8000', ['qwen']),
                runtime('ollama', 'http://192.0.2.5:11434', ['llama3'], 'running', stale()),
            ],
        }] as any[]
        const text = formatEndpointSection(dead, 'qwen', [], { now: NOW, localNodeId: 'main' })
        expect(text).toContain('○ spark ollama (192.0.2.5:11434): llama3 — nicht erreichbar')
        expect(text).toContain('★ spark vllm (192.0.2.5:8000): qwen')
    })

    it('ein Phantom-Runtime aus dem Peer-Hearsay taucht nicht als Endpunkt auf', () => {
        const hearsay = [{
            id: 'ns2', hostname: 'ns2', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(),
            // Heartbeat lists no AI service; the graph still carries the old vLLM.
            software: { node_version: 'v22', package_managers: [], can_install: [], ai_services: [] },
            runtimes: [runtime('vllm', 'http://192.0.2.8:8000', ['qwen'], 'running', fresh(), 'mesh-heartbeat')],
        }] as any[]
        const text = formatEndpointSection(hearsay, 'qwen', [], { now: NOW, localNodeId: 'main' })
        expect(text).not.toContain('192.0.2.8')
        expect(text).not.toContain('vllm')
        expect(text).toContain('*Knoten (1):* ns2')
    })

    it('getombstone-te Runtimes werden nicht gelistet', () => {
        const runtime_ = runtime('vllm', 'http://192.0.2.5:8000', ['qwen'])
        const node = [{ id: 'spark', hostname: 'spark', status: 'online', lastHeartbeat: fresh(), updatedAt: fresh(), runtimes: [runtime_] }] as any[]
        const text = formatEndpointSection(node, 'qwen', [], {
            now: NOW,
            localNodeId: 'main',
            tombstones: [{ id: runtime_.id, deletedAt: fresh() }],
        })
        expect(text).not.toContain('192.0.2.5')
    })

    it('ohne Heartbeat zählt nur der lokale Knoten (Scanner-only) über updatedAt', () => {
        const localScan = [{ id: 'main', hostname: 'main', status: 'online', updatedAt: fresh(), runtimes: [] }] as any[]
        expect(formatEndpointSection(localScan, 'qwen', [], { now: NOW, localNodeId: 'main' })).toContain('*Knoten (1):* main')
        const staleLocal = [{ id: 'main', hostname: 'main', status: 'online', updatedAt: stale(), runtimes: [] }] as any[]
        expect(formatEndpointSection(staleLocal, 'qwen', [], { now: NOW, localNodeId: 'main' })).toContain('main (offline)')
    })
})
