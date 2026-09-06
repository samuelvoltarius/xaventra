import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityGraphSnapshot } from './capability-graph.js'
import { findBestCapability, getCapabilityMap, getMissingCapabilities, initCapabilityOrchestrator, nodesFromCapabilityGraph, suggestInstallation } from './capability-orchestrator.js'

const evidence = vi.hoisted(() => ({ snapshot: null as CapabilityGraphSnapshot | null }))
vi.mock('./capability-graph.js', async importOriginal => ({
    ...await importOriginal<typeof import('./capability-graph.js')>(),
    getCapabilityGraph: () => ({
        getSnapshot: () => structuredClone(evidence.snapshot!),
        pruneStale: () => structuredClone(evidence.snapshot!),
    }),
}))

const now = new Date('2026-09-06T16:00:00Z')
const request = { capability: 'llm', preferLocal: true, preferQuality: false }
function inventory(): CapabilityGraphSnapshot {
    return {
        version: 1, updatedAt: now.toISOString(), nodes: [{
            id: 'worker-a', hostname: 'worker-a', host: '192.0.2.10', status: 'online',
            lastHeartbeat: now.toISOString(), updatedAt: now.toISOString(), capabilities: ['llm', 'embedding'],
            runtimes: [{
                id: 'worker-a:vllm', name: 'vLLM', type: 'llm', endpoint: 'http://192.0.2.10:8000',
                status: 'running', models: ['chat-a', 'chat-b'], capabilities: ['llm', 'tools'],
                verifiedAt: now.toISOString(), verificationSource: 'probe',
            }, {
                id: 'worker-a:ollama', name: 'Ollama', type: 'embeddings', endpoint: 'http://192.0.2.10:11434',
                status: 'installed', models: ['embed-a'], capabilities: ['embedding'],
                verifiedAt: now.toISOString(), verificationSource: 'mesh-heartbeat',
            }],
        }], tombstones: [],
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Inventory reads must not probe the network') }))
    evidence.snapshot = { version: 1, updatedAt: now.toISOString(), nodes: [] }
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('live capability projection', () => {
    it('observes discovery after boot without restart or new network probes', async () => {
        await initCapabilityOrchestrator()
        expect(findBestCapability(request)).toBeNull()
        evidence.snapshot = inventory()
        expect(getCapabilityMap()).toContain('worker-a')
        expect(findBestCapability(request)?.nodeName).toBe('worker-a')
        expect(getMissingCapabilities()).not.toContain('llm')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('keeps runtime names, every model and installed-only status distinct', () => {
        evidence.snapshot = inventory()
        const map = getCapabilityMap()
        expect(map).toContain('vLLM')
        expect(map).toContain('chat-a, chat-b')
        expect(map).not.toContain('Ollama: chat-a')
        expect(map).toContain('installed')
        expect(map).toContain('embed-a')
        expect(getMissingCapabilities()).toContain('embedding')
        expect(findBestCapability({ ...request, capability: 'embedding' })).toBeNull()
        expect(nodesFromCapabilityGraph(evidence.snapshot)[0].capabilities.filter(c => c.name === 'llm').map(c => c.provider))
            .toEqual(['chat-a', 'chat-b'])
    })

    it.each(['stopped', 'offline', 'heartbeat expired', 'probe expired', 'explicit expiry', 'invalid time', 'future time', 'tombstone'])(
        'stops advertising usable capabilities after %s without pruning or restarting', async failure => {
            evidence.snapshot = inventory()
            await initCapabilityOrchestrator()
            expect(findBestCapability(request)).not.toBeNull()
            const node = evidence.snapshot.nodes[0]
            const runtime = node.runtimes[0]
            if (failure === 'stopped') runtime.status = 'stopped'
            if (failure === 'offline') node.status = 'offline'
            if (failure === 'heartbeat expired') node.lastHeartbeat = new Date(now.getTime() - 75_001).toISOString()
            if (failure === 'probe expired') runtime.verifiedAt = new Date(now.getTime() - 300_001).toISOString()
            if (failure === 'explicit expiry') runtime.expiresAt = now.toISOString()
            if (failure === 'invalid time') runtime.verifiedAt = 'invalid'
            if (failure === 'future time') runtime.verifiedAt = new Date(now.getTime() + 300_000).toISOString()
            if (failure === 'tombstone') evidence.snapshot.tombstones = [{ id: runtime.id, deletedAt: now.toISOString() }]
            expect(findBestCapability(request)).toBeNull()
            expect(getMissingCapabilities()).toContain('llm')
            expect(fetch).not.toHaveBeenCalled()
        },
    )

    it('does not expose opaque runtime metadata or credential-bearing endpoints to chat', () => {
        evidence.snapshot = inventory()
        const runtime = evidence.snapshot.nodes[0].runtimes[0]
        runtime.endpoint = 'https://example.invalid/v1?api_key=inventory-test-secret'
        runtime.metadata = { auth: 'inventory-test-secret' }
        expect(getCapabilityMap()).not.toContain('inventory-test-secret')
    })

    it('suggests reuse of installed software, not a duplicate install on an invented node', () => {
        evidence.snapshot = inventory()
        const suggestion = suggestInstallation('embedding')!
        expect(suggestion).toContain('worker-a')
        expect(suggestion).toContain('Ollama')
        expect(suggestion).toContain('bereits installiert')
        expect(suggestion).not.toMatch(/pi5|jetson|pip install|ollama pull/)
        expect(suggestInstallation('llm')).toContain('bereits verfuegbar')
    })

    it('does not invent hardware suitability or commands when no evidence exists', () => {
        const suggestion = suggestInstallation('stt')!
        expect(suggestion).toContain('kein aktuell erreichbarer')
        expect(suggestion).not.toMatch(/jetson|pip install|nova-stt-server/)
    })
})
