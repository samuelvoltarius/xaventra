import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StrengthFacts, StrengthNodeFacts } from './node-strengths.js'

// 2.86 Paket J Punkt 3 / Zusammenführung: der Mesh-Router hatte eigene, fest
// eingetragene Knoten (erfundene IPs) und pingte sie. Jetzt entscheidet er
// über rankNodes aus gemessenen Fakten — ohne Ping, ohne SSH, mit Begründung.
const childProcess = vi.hoisted(() => ({ exec: vi.fn(), execFile: vi.fn(), execSync: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const node = (id: string, patch: Partial<StrengthNodeFacts>, hw: Partial<StrengthNodeFacts['hardware']> = {}): StrengthNodeFacts => ({
    nodeId: id, local: false, lastSeen: NOW - 10_000, runtimes: [], tools: [], selfCheck: 'ok', ...patch,
    hardware: { cpus: 4, ramGB: 8, gpuName: null, gpuBackend: 'cpu', viaVllm: false, ...hw },
})
const facts: StrengthFacts = {
    now: NOW, measurements: [],
    nodes: [
        node('main-x', { local: true, role: 'main' }, { cpus: 8, ramGB: 32 }),
        node('knoten-a', { tools: ['ffmpeg'], runtimes: [{ name: 'comfyui', type: 'image', models: [], running: true }] }, { gpuName: 'NVIDIA RTX 4090', gpuBackend: 'cuda', gpuVramGB: 24, cpus: 16 }),
    ],
}

beforeEach(() => { for (const fn of Object.values(childProcess)) fn.mockClear() })

describe('Mesh-Router über Knoten-Stärken', () => {
    it('Bilder erzeugen → Knoten A, mit Begründung aus den Fakten', async () => {
        const { routeTask, detectMeshTaskType } = await import('./mesh-router.js')
        expect(detectMeshTaskType('Erzeuge ein Bild von einem Leuchtturm')).toBe('image_generation')
        const decision = await routeTask('Erzeuge ein Bild von einem Leuchtturm', false, facts)
        expect(decision).toMatchObject({ nodeId: 'knoten-a', isLocal: false, capability: 'bilder', taskType: 'image_generation' })
        expect(decision.reason).toMatch(/Bilder erzeugen → knoten-a: .*comfyui/)
    })

    it('Video umwandeln → Knoten mit ffmpeg; allgemeine Aufgaben bleiben lokal', async () => {
        const { routeTask } = await import('./mesh-router.js')
        expect((await routeTask('Konvertiere das Video nach mp4', false, facts)).nodeId).toBe('knoten-a')
        const general = await routeTask('Wie spät ist es?', false, facts)
        expect(general).toMatchObject({ isLocal: true, nodeId: 'main-x' })
    })

    it('kein geeigneter Knoten → lokal, Grund nennt den Ausschluss', async () => {
        const { routeTask } = await import('./mesh-router.js')
        const decision = await routeTask('Transkribiere die Sprachaufnahme mit whisper', false, facts)
        expect(decision.isLocal).toBe(true)
        expect(decision.reason).toMatch(/kein geeigneter Knoten/)
    })

    it('pingt nicht und startet keinen Prozess', async () => {
        const { routeTask, getRoutingDiagnostics } = await import('./mesh-router.js')
        await routeTask('Erzeuge ein Bild', false, facts)
        expect(await getRoutingDiagnostics(facts)).toMatch(/Wer kann was am besten/)
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
    })

    it('keine fest eingetragenen Knoten mehr', async () => {
        const router = await import('./mesh-router.js') as Record<string, unknown>
        expect(router.NODE_PROFILES).toBeUndefined()
        expect((router.default as Record<string, unknown>).NODE_PROFILES).toBeUndefined()
        expect(router.scoreAllNodes).toBeUndefined()
    })
    it('Prompt-Block: Delegation nur über den signierten Mesh-Weg, kein ssh', async () => {
        const { routeTask, meshRoutingPromptBlock } = await import('./mesh-router.js')
        const remote = meshRoutingPromptBlock(await routeTask('Erzeuge ein Bild', false, facts))
        expect(remote).toContain('## 🌐 MESH ROUTING (automatisch erkannt)')
        expect(remote).toContain('mesh_node="knoten-a"')
        expect(remote).toContain('faehigkeit="bilder"')
        expect(remote).not.toMatch(/ssh_command/)
        expect(meshRoutingPromptBlock(await routeTask('Wie spät ist es?', false, facts))).toContain('Lokal ausführen.')
    })
})
