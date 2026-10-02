import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StrengthFacts, StrengthNodeFacts } from '../mesh/node-strengths.js'

// 2.86 Paket J Punkt 3: Aufgaben nach Stärke über den vorhandenen Weg
// (Subagent → signierter Mesh-Transport). mesh_node="auto" wählt per rankNodes,
// die Begründung steht im Outcome-Ledger des Elternlaufs.
const mesh = vi.hoisted(() => ({ sendAgentRequest: vi.fn(), waitForMeshRunResult: vi.fn(), cancelMeshRun: vi.fn() }))
vi.mock('../mesh/mesh-transport-runtime.js', () => mesh)

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const node = (id: string, patch: Partial<StrengthNodeFacts>, hw: Partial<StrengthNodeFacts['hardware']> = {}): StrengthNodeFacts => ({
    nodeId: id, local: false, lastSeen: NOW - 10_000, runtimes: [], tools: [], selfCheck: 'ok', ...patch,
    hardware: { cpus: 4, ramGB: 8, gpuName: null, gpuBackend: 'cpu', viaVllm: false, ...hw },
})
const facts: StrengthFacts = {
    now: NOW, measurements: [],
    nodes: [
        node('main-x', { local: true, role: 'main', tools: ['ffmpeg'] }, { cpus: 64, ramGB: 128 }),
        node('knoten-a', { runtimes: [{ name: 'comfyui', type: 'image', models: ['sdxl'], running: true }] }, { gpuName: 'NVIDIA RTX 4090', gpuBackend: 'cuda', gpuVramGB: 24 }),
    ],
}
vi.mock('../mesh/node-strengths.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../mesh/node-strengths.js')>()),
    collectStrengthFacts: vi.fn(async () => facts),
}))

import { resolveMeshPlacement, spawnSubagent } from './subagent-orchestrator.js'
import { OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

let dir = ''
beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'xav-placement-'))
    mesh.sendAgentRequest.mockResolvedValue({ requestId: 'request-1', ack: { status: 'delivered', transport: 'direct' } })
    mesh.waitForMeshRunResult.mockResolvedValue({ requestId: 'request-1', success: true, result: 'Bild fertig', evidence: [] })
    mesh.cancelMeshRun.mockResolvedValue({ status: 'delivered' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Subagent mesh_node="auto" — Platzierung nach Stärke', () => {
    it('Bilder → Knoten A über den signierten Weg, Begründung im Ledger des Elternlaufs', async () => {
        const ledger = new OutcomeLedger(dir, false)
        const result = await withOutcomeLedger(ledger, () => withExecutionPolicyContext({ runId: 'parent-run', userId: 'owner-1' },
            () => spawnSubagent({ task: 'Erzeuge ein Bild von einem Leuchtturm', userId: 'owner-1', meshNode: 'auto', timeoutMs: 500 })))
        expect(mesh.sendAgentRequest).toHaveBeenCalledWith('knoten-a', 'Erzeuge ein Bild von einem Leuchtturm', expect.any(Object))
        expect(result).toMatchObject({ status: 'completed', mode: 'mesh', meshNode: 'knoten-a', output: 'Bild fertig' })
        const route = ledger.getRun('parent-run')!.events.find(event => event.type === 'route.selected')!
        expect(route.payload).toMatchObject({ meshNode: 'knoten-a', meshCapability: 'bilder' })
        expect(String(route.payload.reason)).toMatch(/Bilder erzeugen → knoten-a: /)
        expect(String(route.payload.reason)).toContain('RTX 4090')
        expect(String(route.payload.reason)).toContain('comfyui')
        // Die Platzierung überschreibt nicht den Modell-Knoten des Elternlaufs.
        expect(ledger.getRun('parent-run')!.node).toBeUndefined()
    })

    it('explizite Fähigkeit schlägt die Texterkennung; bester Knoten ist dieser → lokal, auch das steht im Ledger', async () => {
        const placement = await resolveMeshPlacement({ task: 'mach was', meshNode: 'auto', capability: 'medien' }, facts)
        expect(placement).toMatchObject({ nodeId: 'main-x', capability: 'medien', local: true })
        expect(placement.meshNode).toBeUndefined()
        expect(placement.reason).toMatch(/Video\/Audio umwandeln → main-x/)
    })

    it('ohne erkennbare Fähigkeit oder ohne geeigneten Knoten bleibt die Aufgabe lokal (kein Raten)', async () => {
        const chat = await resolveMeshPlacement({ task: 'Wie spät ist es?', meshNode: 'auto' }, facts)
        expect(chat).toMatchObject({ local: true })
        expect(chat.meshNode).toBeUndefined()
        const none = await resolveMeshPlacement({ task: 'x', meshNode: 'auto', capability: 'stt' }, facts)
        expect(none).toMatchObject({ local: true })
        expect(none.meshNode).toBeUndefined()
        expect(none.reason).toMatch(/kein geeigneter Knoten/)
        await expect(resolveMeshPlacement({ task: 'x', meshNode: 'auto', capability: 'zaubern' }, facts)).resolves.toMatchObject({ local: true })
    })

    it('ein explizit genannter Knoten bleibt unverändert (keine Umleitung)', async () => {
        await spawnSubagent({ task: 'Erzeuge ein Bild', meshNode: 'worker-1', timeoutMs: 500 })
        expect(mesh.sendAgentRequest).toHaveBeenCalledWith('worker-1', 'Erzeuge ein Bild', expect.any(Object))
    })
})
