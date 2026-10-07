/**
 * 2.89 (Paket C): ONE fixture for "the same question, asked in every place, gets the same answer".
 * Documentation addresses only (192.0.2.x). Used by capability-truth.test.ts.
 *
 *  - node-main:   this machine; plain display adapter (no GPU), git + ffmpeg
 *  - gpu-box:     peer with a signed profile; NVIDIA GPU, vLLM (chat model) and Whisper running
 *  - registry-pi: only in the registry (Supabase-style row); Ollama with an embedding model
 *  - old-box:     registry row whose last heartbeat is 20 minutes old -> offline
 */
import type { NodeProfile } from '../core/node-profile.js'
import type { CapabilityGraphSnapshot } from '../mesh/capability-graph.js'

export const NOW = Date.now()
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

export function fixtureProfile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'x', hostname: 'x', platform: 'linux', arch: 'x64', version: '2.88.3', role: 'worker', runtime: 'native',
        rootReadOnly: false, noNewPrivileges: false, cpus: 4, ramGB: 8, gpu: { name: null, backend: 'cpu', viaVllm: false },
        services: [], installPath: 'none', tools: ['git', 'ffmpeg'], selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...over,
    }
}

export const FIXTURE_CONFIG = {
    provider: 'vllm',
    model: 'chat-a',
    providers: { vllm: { enabled: true, baseUrl: 'http://192.0.2.10:8000' } },
}

/** Scout nodes (local + signed peer). `localId` is this machine's real node id. */
export function fixtureScoutNodes(localId: string) {
    return [
        {
            nodeId: localId, local: true,
            // A display adapter name only: the old paths called this a GPU.
            profile: fixtureProfile({ nodeId: localId, hostname: 'main-host', cpus: 8, ramGB: 32, gpu: { name: 'Microsoft Basic Display Adapter', backend: 'cpu', viaVllm: false } }),
        },
        {
            nodeId: 'gpu-box', local: false, lastSeen: NOW - 10_000,
            profile: fixtureProfile({
                nodeId: 'gpu-box', hostname: 'gpu-box', cpus: 16, ramGB: 64, gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: true, vramGB: 24 },
                services: [{ name: 'vllm', type: 'llm', status: 'running' }, { name: 'whisper', type: 'stt', status: 'running' }],
            }),
        },
    ]
}

export const FIXTURE_GRAPH: CapabilityGraphSnapshot = {
    version: 1, updatedAt: iso(0), nodes: [{
        id: 'gpu-box', hostname: 'gpu-box', host: '192.0.2.20', status: 'online', lastHeartbeat: iso(-10_000), updatedAt: iso(-10_000),
        capabilities: ['llm', 'stt'],
        hardware: { cpu: 'x', cores: 16, arch: 'x64', ram_gb: 64, disk_gb: 1000, disk_free_gb: 500, gpu: 'NVIDIA RTX 4090', gpu_vram_mb: 24576, os_name: 'Linux', os_version: '' },
        runtimes: [
            { id: 'gpu-box:vllm', name: 'vLLM', type: 'llm', endpoint: 'http://192.0.2.20:8000', status: 'running', models: ['chat-a'], capabilities: ['llm'], verifiedAt: iso(-10_000), verificationSource: 'probe' },
            { id: 'gpu-box:whisper', name: 'whisper', type: 'stt', endpoint: 'http://192.0.2.20:8765', status: 'running', models: ['whisper-large'], capabilities: ['stt'], verifiedAt: iso(-10_000), verificationSource: 'probe' },
        ],
    }],
}

/** Registry rows as the local mesh file holds them (what Supabase sync writes). */
export function fixtureRegistryRows() {
    const software = (running: boolean) => ({
        node_version: '2.88.3', package_managers: [], can_install: [], ffmpeg: true, git: true, ollama_models: ['nomic-embed-text'],
        ai_services: [{ name: 'ollama', type: 'embeddings', endpoint: 'http://192.0.2.30:11434', status: running ? 'running' : 'stopped', models: ['nomic-embed-text'] }],
    })
    const hardware = { cpu: 'arm', cores: 4, arch: 'arm64', ram_gb: 8, disk_gb: 256, disk_free_gb: 100, os_name: 'Linux', os_version: '' }
    return [
        { node_id: 'registry-pi', hostname: 'registry-pi', ip: '192.0.2.30', platform: 'linux', version: '2.88.3', tools_count: 10, status: 'online', capabilities: ['worker-only', 'main-ineligible'], hardware, software: software(true), last_heartbeat: iso(-20_000), lifecycle_state: 'active' },
        { node_id: 'old-box', hostname: 'old-box', ip: '192.0.2.31', platform: 'linux', version: '2.87.0', tools_count: 10, status: 'online', capabilities: ['main-eligible'], hardware, software: software(false), last_heartbeat: iso(-20 * 60_000), lifecycle_state: 'active' },
    ]
}