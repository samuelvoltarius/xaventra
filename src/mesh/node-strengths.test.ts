import { describe, expect, it } from 'vitest'
import type { NodeProfile } from '../core/node-profile.js'
import { deriveStrength, formatStrengthList, rankNodes, shortReason, skillForTask, type StrengthInput } from './node-strengths.js'

const NOW = 1_800_000_000_000

function profile(over: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'x', hostname: 'x', platform: 'linux', arch: 'x64', version: '2.88.0', role: 'worker', runtime: 'native',
        rootReadOnly: false, noNewPrivileges: false, cpus: 8, ramGB: 32, gpu: { name: null, backend: 'cpu', viaVllm: false },
        services: [], installPath: 'none', tools: ['git', 'ffmpeg'],
        selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '', ...over,
    }
}

const gpuNode = (over: Partial<StrengthInput> = {}): StrengthInput => ({
    nodeId: 'gpu-node', local: false, lastSeen: NOW - 20_000, rttMs: 4,
    profile: profile({ cpus: 20, ramGB: 128, gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true } }),
    graphRuntimes: [{ name: 'vllm', type: 'vllm', models: ['qwen3-coder-30b'], available: true }],
    load: { gpuUtilPercent: 5, cpuPerCore: 0.2, memFreePercent: 40, diskFreeGB: 900 },
    ...over,
})
const smallNode = (over: Partial<StrengthInput> = {}): StrengthInput => ({
    nodeId: 'small-node', local: true, profile: profile({ cpus: 4, ramGB: 8 }), load: { diskFreeGB: 50 }, ...over,
})
const nasNode = (over: Partial<StrengthInput> = {}): StrengthInput => ({
    nodeId: 'nas-node', local: false, lastSeen: NOW - 30_000, modelOnly: true,
    profile: profile({ cpus: 4, ramGB: 16, tools: [] }), load: { diskFreeGB: 8000 }, ...over,
})

describe('Mesh-Gehirn: Stärkenprofil ohne Config', () => {
    it('derives memory, GPU state and skills only from profile, graph and heartbeat', () => {
        const node = deriveStrength(gpuNode(), NOW)
        expect(node.online).toBe(true)
        expect(node.gpu.unified).toBe(true)
        expect(node.modelMemoryGB).toBe(128)
        expect(node.modelMemoryHow).toBe('gemeinsamer Speicher')
        expect(node.skills).toEqual(expect.arrayContaining(['grosse-modelle', 'llm', 'code', 'medien', 'speicher', 'rechnen']))
        expect(node.skills).not.toContain('bilder')
    })

    it('uses discrete VRAM from the profile and marks a stale peer offline', () => {
        const node = deriveStrength({ ...gpuNode(), lastSeen: NOW - 10 * 60_000, profile: profile({ gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false, vramGB: 24 } }) }, NOW)
        expect(node.modelMemoryHow).toBe('VRAM')
        expect(node.modelMemoryGB).toBe(24)
        expect(node.online).toBe(false)
    })
})

describe('Mesh-Gehirn: Routing mit menschlichem Grund', () => {
    const nodes = [deriveStrength(gpuNode(), NOW), deriveStrength(smallNode(), NOW), deriveStrength(nasNode(), NOW)]

    it('routes a large-model task to the GPU node with a short reason', () => {
        const ranking = rankNodes('grosse-modelle', nodes)
        expect(ranking.ranked[0].nodeId).toBe('gpu-node')
        expect(shortReason(ranking)).toBe('gpu-node: GPU frei, Modell qwen3-coder-30b geladen, 128 GB gemeinsamer Speicher')
        expect(ranking.excluded.map(item => item.nodeId)).toEqual(['nas-node', 'small-node'])
    })

    it('storage goes to the NAS, never to a node without reported disk', () => {
        const ranking = rankNodes('speicher', nodes)
        expect(ranking.ranked[0].nodeId).toBe('nas-node')
        expect(shortReason(ranking)).toBe('nas-node: 8 TB frei, Datenspeicher')
    })

    it('a busy GPU loses against an idle one and says why', () => {
        const busy = deriveStrength(gpuNode({ nodeId: 'busy-gpu', load: { gpuUtilPercent: 95 } }), NOW)
        const idle = deriveStrength(gpuNode({ nodeId: 'idle-gpu' }), NOW)
        const ranking = rankNodes('llm', [busy, idle])
        expect(ranking.ranked.map(item => item.nodeId)).toEqual(['idle-gpu', 'busy-gpu'])
        expect(ranking.ranked[1].reasons).toContain('GPU ausgelastet')
    })

    it('excludes offline and critical nodes with a reason and is deterministic', () => {
        const offline = deriveStrength(gpuNode({ nodeId: 'gone', lastSeen: NOW - 3_600_000 }), NOW)
        const crit = deriveStrength(gpuNode({ nodeId: 'sick', profile: profile({ selfCheck: { status: 'crit', checkedAt: '', items: [] } }) }), NOW)
        const ranking = rankNodes('rechnen', [crit, offline, ...nodes])
        expect(ranking.excluded).toEqual(expect.arrayContaining([{ nodeId: 'gone', reason: 'offline' }, { nodeId: 'sick', reason: 'Selbstprüfung kritisch' }]))
        expect(rankNodes('rechnen', [...nodes].reverse())).toEqual(rankNodes('rechnen', nodes))
    })

    it('says plainly when nothing fits', () => {
        expect(shortReason(rankNodes('bilder', nodes))).toMatch(/^Für Bilder erzeugen passt gerade kein Knoten/)
    })

    it('maps everyday task wording to a skill without an LLM', () => {
        expect(skillForTask('Erzeuge ein Bild von einem Leuchtturm')).toBe('bilder')
        expect(skillForTask('konvertier das Video nach mp4')).toBe('medien')
        expect(skillForTask('Bitte transkribiere die Sprachnachricht')).toBe('stt')
        expect(skillForTask('Fix die Tests im Repo')).toBe('code')
        expect(skillForTask('Wie spät ist es?')).toBeNull()
    })
})

describe('Mesh-Gehirn: Owner-Frage „was kann welcher Node?“', () => {
    it('answers with one short line per node', () => {
        const text = formatStrengthList([
            deriveStrength(gpuNode(), NOW), deriveStrength(smallNode(), NOW), deriveStrength(nasNode(), NOW),
            deriveStrength(gpuNode({ nodeId: 'old-node', lastSeen: NOW - 3 * 3_600_000 }), NOW),
        ], NOW)
        const lines = text.split('\n')
        expect(lines[0]).toBe('*Was kann welcher Knoten?*')
        expect(lines[1]).toBe('• small-node (hier) — Programmieren, Video/Audio umwandeln, Speicher · 4 Kerne, 8 GB RAM, 50 GB frei')
        expect(lines).toContain('• gpu-node — große Modelle, Sprachmodell, Programmieren, Video/Audio umwandeln, Speicher · GPU frei (128 GB), Modell qwen3-coder-30b geladen, 900 GB frei')
        expect(lines).toContain('• nas-node — Speicher · 4 Kerne, 16 GB RAM, 8 TB frei')
        expect(lines).toContain('• old-node — offline seit 3 Std.')
        expect(lines).toHaveLength(5)
    })
})

describe('Mesh-Gehirn: GPU und große Modelle nur mit belegter eigener GPU', () => {
    const serverVga = (over: Partial<StrengthInput> = {}): StrengthInput => ({
        nodeId: 'plain-server', local: false, lastSeen: NOW - 20_000,
        // Display adapter text of a server board (not a compute GPU): name set, backend cpu, no VRAM.
        profile: profile({ cpus: 32, ramGB: 128, gpu: { name: '03:00.0 VGA compatible controller: Example BMC Graphics', backend: 'cpu', viaVllm: false } }),
        load: { diskFreeGB: 500 }, ...over,
    })

    it('does not call a display adapter without VRAM a GPU, and keeps large models out', () => {
        const node = deriveStrength(serverVga(), NOW)
        expect(node.skills).not.toContain('grosse-modelle')
        const list = formatStrengthList([node], NOW)
        expect(list).not.toMatch(/GPU/)
        expect(list).not.toContain('große Modelle')
        expect(list).toContain('32 Kerne, 128 GB RAM')
    })

    it('does not take a VM or NAS without any GPU info for a GPU node', () => {
        const vm = deriveStrength({ nodeId: 'vm', local: false, lastSeen: NOW - 1_000, profile: profile({ cpus: 6, ramGB: 64 }) }, NOW)
        expect(vm.skills).not.toContain('grosse-modelle')
        expect(formatStrengthList([vm], NOW)).not.toMatch(/GPU/)
    })

    it('still reports a real GPU, unified memory and a RAM-only node running a big model', () => {
        const real = deriveStrength({ ...serverVga(), nodeId: 'real', profile: profile({ ramGB: 64, gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false, vramGB: 24 } }) }, NOW)
        expect(real.skills).toContain('grosse-modelle')
        expect(formatStrengthList([real], NOW)).toContain('GPU')
        const big = deriveStrength({ ...serverVga(), nodeId: 'big-cpu', graphRuntimes: [{ name: 'llama.cpp', type: 'llamacpp', models: ['llama-70b-q4'], available: true }] }, NOW)
        expect(big.skills).toContain('grosse-modelle')
        const small = deriveStrength({ ...serverVga(), nodeId: 'small-cpu', graphRuntimes: [{ name: 'ollama', type: 'ollama', models: ['qwen3:8b'], available: true }] }, NOW)
        expect(small.skills).not.toContain('grosse-modelle')
    })
})
