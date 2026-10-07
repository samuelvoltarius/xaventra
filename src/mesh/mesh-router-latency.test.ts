import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import { deriveStrength } from './node-strengths.js'

// MI-2 (kept): node addresses come from shared tables and are untrusted. Since
// 2.88 the router does not ping or SSH at all: latency is the measured
// heartbeat round trip, the decision comes from the signed strength profiles.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn((_cmd: string, _options: unknown, callback: (error: Error | null) => void) => callback(null)),
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => callback(null)),
}))
vi.mock('node:child_process', () => childProcess)
vi.mock('./mesh-registry.js', () => ({
    getAvailableNodes: async () => [
        { node_id: 'evil', hostname: 'evil', ip: '192.0.2.1;touch /tmp/pwned', capabilities: ['chat'], status: 'online' },
        { node_id: 'evil2', hostname: 'evil2', ip: '$(id)', capabilities: ['chat'], status: 'online' },
    ],
    getLocalNodeId: () => 'here',
}))

const NOW = Date.now()
function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'x', hostname: 'x', platform: 'linux', arch: 'x64', version: '2.88.0', role: 'worker', runtime: 'native',
        rootReadOnly: false, noNewPrivileges: false, cpus: 4, ramGB: 8, gpu: { name: null, backend: 'cpu', viaVllm: false },
        services: [], installPath: 'none', tools: ['git', 'ffmpeg'], selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...over,
    }
}
const nodes = [
    deriveStrength({ nodeId: 'here', local: true, profile: profile() }, NOW),
    deriveStrength({
        nodeId: 'gpu-box', local: false, lastSeen: NOW - 10_000, rttMs: 3,
        profile: profile({ cpus: 16, ramGB: 64, gpu: { name: 'NVIDIA RTX', backend: 'cuda', viaVllm: false, vramGB: 24 } }),
        graphRuntimes: [{ name: 'comfyui', type: 'image', models: [], available: true }, { name: 'ollama', type: 'ollama', models: ['qwen3:14b'], available: true }],
        load: { gpuUtilPercent: 3 },
    }, NOW),
]

describe('mesh-router routes by strength, never by ping or SSH', () => {
    beforeEach(() => { childProcess.exec.mockClear(); childProcess.execFile.mockClear() })

    it('sends an image job to the GPU node with a short human reason', async () => {
        const { routeTask } = await import('./mesh-router.js')
        const decision = await routeTask('Erzeuge ein Bild von einem Leuchtturm', false, nodes)
        expect(decision).toMatchObject({ nodeId: 'gpu-box', isLocal: false, skill: 'bilder' })
        expect(decision.reason).toBe('gpu-box: GPU frei, comfyui läuft, schnell erreichbar')
        expect(childProcess.exec).not.toHaveBeenCalled()
        expect(childProcess.execFile).not.toHaveBeenCalled()
    })

    it('keeps ordinary chat on this node', async () => {
        const { routeTask } = await import('./mesh-router.js')
        const decision = await routeTask('Wie wird das Wetter morgen?', false, nodes)
        expect(decision).toMatchObject({ nodeId: 'here', isLocal: true, skill: null })
    })

    it('falls back to this node with the reason when nothing fits', async () => {
        const { routeTask } = await import('./mesh-router.js')
        const decision = await routeTask('Bitte transkribiere die Sprachnachricht', false, nodes)
        expect(decision.isLocal).toBe(true)
        expect(decision.reason).toMatch(/^Für Sprache → Text passt gerade kein Knoten/)
    })

    it('has no fixed node list or hard-coded hosts any more', async () => {
        const source = (await import('node:fs')).readFileSync(new URL('./mesh-router.ts', import.meta.url), 'utf8')
        expect(source).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
        expect(source).not.toMatch(/NODE_PROFILES|sshUser|child_process|'ping'/)
    })
})
