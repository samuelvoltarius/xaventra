import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityGraph, type CapabilityGraphSnapshot } from './capability-graph.js'
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

describe('local runtimes reach the projection (live 2.88.1: vLLM and whisper on the main node)', () => {
    const stamp = now.toISOString()
    const scan = {
        lastScan: stamp, scanDurationMs: 5, services: [
            { id: 'vllm@localhost:8000', name: 'vllm', type: 'llm', provider: 'vllm', host: '127.0.0.1', port: 8000, endpoint: 'http://127.0.0.1:8000',
                models: ['chat-a', 'chat-b'], status: 'running', lastSeen: stamp, sourceNode: 'local' },
            { id: 'whisper@localhost:9000', name: 'whisper-gpu', type: 'stt', provider: 'whisper', host: '127.0.0.1', port: 9000, endpoint: 'http://127.0.0.1:9000',
                models: ['whisper-small'], status: 'running', lastSeen: stamp, sourceNode: 'local' },
            { id: 'ollama@localhost:11434', name: 'ollama', type: 'llm', provider: 'ollama', host: '127.0.0.1', port: 11434, endpoint: 'http://127.0.0.1:11434',
                models: [], status: 'installed', lastSeen: stamp, sourceNode: 'local' },
        ],
    } as any
    const selfMesh = [{
        node_id: 'main-node', hostname: 'main-node', ip: '192.0.2.5', platform: 'linux', version: '1', tools_count: 1, status: 'online', capabilities: [], last_heartbeat: stamp,
    }] as any

    it('keeps local runtimes on the main node although NOVA_NODE_ID is not set (scanner passes the real node id)', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        // Main node without NOVA_NODE_ID: the id comes from the registry, never undefined.
        graph.ingest(scan, selfMesh, 'main-node')
        evidence.snapshot = graph.getSnapshot()
        expect(getMissingCapabilities()).not.toContain('llm')
        expect(getMissingCapabilities()).not.toContain('stt')
        expect(findBestCapability(request)?.nodeName).toBe('main-node')
    })

    it('does not drop a scanner-only local node as unknown when no node id was passed', () => {
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        graph.ingest(scan, [], undefined)
        evidence.snapshot = graph.getSnapshot()
        expect(getMissingCapabilities()).not.toContain('llm')
        expect(getMissingCapabilities()).not.toContain('stt')
    })

    it('recognises OpenAI-compatible and whisper runtimes by their own type names, not only "llm"/"stt"', () => {
        evidence.snapshot = {
            version: 1, updatedAt: stamp, tombstones: [], nodes: [{
                id: 'main-node', hostname: 'main-node', status: 'online', lastHeartbeat: stamp, updatedAt: stamp, capabilities: [],
                runtimes: [
                    { id: 'a', name: 'vllm', type: 'vllm', endpoint: 'http://192.0.2.5:8000', status: 'running', models: ['chat-a'], capabilities: ['vllm', 'vllm'], verifiedAt: stamp, verificationSource: 'mesh-heartbeat' },
                    { id: 'b', name: 'whisper-server', type: 'whisper', endpoint: 'http://192.0.2.5:9000', status: 'running', models: [], capabilities: ['whisper', 'whisper-server'], verifiedAt: stamp, verificationSource: 'mesh-heartbeat' },
                    { id: 'c', name: 'ollama', type: 'ollama', endpoint: 'http://192.0.2.5:11434', status: 'installed', models: [], capabilities: ['ollama'], verifiedAt: stamp, verificationSource: 'mesh-heartbeat' },
                ],
            }],
        }
        expect(getMissingCapabilities()).not.toContain('llm')
        expect(getMissingCapabilities()).not.toContain('stt')
        expect(suggestInstallation('llm')).toMatch(/bereits verfuegbar: main-node\/chat-a/)
    })

    it('does not offer "ollama already installed" for a capability a running local runtime stands for after restart', async () => {
        // Boot with the persisted graph: running runtimes are not yet re-verified (older than 5 min).
        const old = new Date(now.getTime() - 3_600_000).toISOString()
        const graph = new CapabilityGraph(join(mkdtempSync(join(tmpdir(), 'nova-cap-')), 'graph.json'))
        graph.ingest({ ...scan, services: scan.services.map((service: any) => ({ ...service, lastSeen: old })) }, [{ ...selfMesh[0], last_heartbeat: stamp }], 'main-node')
        evidence.snapshot = graph.getSnapshot()
        const lines: string[] = []
        const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
        await initCapabilityOrchestrator()
        log.mockRestore()
        const text = lines.join(' | ')
        expect(text).not.toMatch(/llm: ollama/)
        expect(text).not.toMatch(/Missing:.*\b(llm|stt)\b/)
    })
    it('counter-check: a stopped runtime stays missing and is not reported as pending', async () => {
        evidence.snapshot = {
            version: 1, updatedAt: stamp, tombstones: [], nodes: [{
                id: 'main-node', hostname: 'main-node', status: 'online', lastHeartbeat: stamp, updatedAt: stamp, capabilities: [],
                runtimes: [{ id: 'a', name: 'vllm', type: 'llm', endpoint: 'http://192.0.2.5:8000', status: 'stopped', models: ['chat-a'], capabilities: ['llm'], verifiedAt: stamp, verificationSource: 'probe' }],
            }],
        }
        const lines: string[] = []
        const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
        await initCapabilityOrchestrator()
        log.mockRestore()
        const text = lines.join(' | ')
        expect(text).toMatch(/Missing:.*\bllm\b/)
        expect(text).not.toContain('Noch nicht neu bestaetigt')
    })
})
