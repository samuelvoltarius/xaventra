import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// P9 Punkt 2 + 6: Auftrags-Schritte mit `an` gehen über core/delegation.ts an
// einen anderen Agenten; der Auftrag wartet auf die Rückmeldung. Der 15-s-
// Recovery-Takt läuft nur, solange ein Checkpoint auf seine Lease wartet.

const mesh = vi.hoisted(() => ({ checkpoints: [] as any[], owner: null as any }))
const dlg = vi.hoisted(() => ({
    result: { ok: true, record: { id: 'dlg-aaaaaaaaaaaa', status: 'gesendet' } } as any,
    calls: [] as any[],
    listener: null as null | ((record: any, info: { verified: boolean }) => void),
}))

vi.mock('../mesh/leader-election.js', () => ({
    getServiceFencingToken: () => ({ epoch: 1, token: 'fence-token' }),
    stopLeaseRenewal: () => { },
}))
vi.mock('../mesh/mesh-registry.js', () => ({
    acquireMissionOwnership: async () => mesh.owner ?? ({ ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token' }),
    publishMissionCheckpoint: async () => true,
    listRecoverableMissionCheckpoints: async () => mesh.checkpoints,
}))
vi.mock('./delegation.js', () => ({
    delegate: vi.fn(async (request: any) => { dlg.calls.push(request); return dlg.result }),
    onDelegationSettled: (listener: any) => { dlg.listener = listener; return () => { } },
}))

afterEach(() => {
    vi.useRealTimers()
    dlg.calls = []
    dlg.result = { ok: true, record: { id: 'dlg-aaaaaaaaaaaa', status: 'gesendet' } }
    mesh.checkpoints = []
    mesh.owner = null
})

function step(id: number, extra: Record<string, unknown> = {}) {
    return { id, description: `Schritt ${id}`, command: `mache ${id}`, status: 'pending' as const, retries: 0, ...extra }
}

async function seed(handleMessage: (...args: any[]) => Promise<void>, first: Record<string, unknown> = { an: 'codex' }) {
    vi.resetModules()
    const dataDir = join(process.cwd(), '.nova-data')
    writeFileSync(join(dataDir, 'auftraege-config.json'), JSON.stringify({ timeoutPerStep: 1_000, delayBetweenSteps: 10, notifyEveryNSteps: 99 }))
    writeFileSync(join(dataDir, 'auftraege.json'), JSON.stringify({
        active: {
            id: 'dlg-auftrag', goal: 'Fixture-Ziel', summary: '', steps: [step(1, first), step(2)], currentStep: 0,
            status: 'active', createdBy: 'fixture-user', channel: 'internal', createdAt: 1, progressUpdates: [],
            ownerNode: 'fixture-node', leaseEpoch: 1, fencingToken: 'fence-token',
        },
        history: [],
        queue: [],
    }))
    const executor = await import('./autonomous-executor.js')
    executor.initMissionEngine({ handleMessage: handleMessage as any, notifyFn: async () => { }, llm: null, state: {} })
    return executor
}

describe('P9 Aufträge delegieren Schritte', () => {
    it('ein Schritt mit an=codex wird übergeben, der Auftrag wartet und läuft nach der verifizierten Rückmeldung weiter', async () => {
        vi.useFakeTimers()
        const handleMessage = vi.fn(async () => { })
        const executor = await seed(handleMessage)
        await vi.advanceTimersByTimeAsync(5_100)
        expect(dlg.calls).toHaveLength(1)
        expect(dlg.calls[0]).toMatchObject({ to: 'codex', auftrag: 'mache 1', missionId: 'dlg-auftrag' })
        expect(handleMessage).not.toHaveBeenCalled()
        const waiting = executor.getActiveMission()!
        expect(waiting.steps[0]).toMatchObject({ status: 'active', delegationId: 'dlg-aaaaaaaaaaaa' })
        expect(waiting.progressUpdates.at(-1)).toMatch(/an Codex übergeben/)

        // the recovery/resume path does not run the waiting step again
        await vi.advanceTimersByTimeAsync(60_000)
        expect(handleMessage).not.toHaveBeenCalled()

        expect(dlg.listener).toBeTypeOf('function')
        dlg.listener!({ id: 'dlg-aaaaaaaaaaaa', missionId: 'dlg-auftrag', status: 'fertig', pruefung: { ergebnis: 'verifiziert', detail: 'CI grün' } }, { verified: true })
        const after = executor.getActiveMission()!
        expect(after.steps[0].status).toBe('done')
        expect(after.currentStep).toBe(1)
        await vi.advanceTimersByTimeAsync(100)
        expect(handleMessage).toHaveBeenCalledTimes(1)
        expect(String((handleMessage.mock.calls[0] as unknown[])[2])).toContain('mache 2')
    })

    it('Gegenprobe: unverifiziert zählt nicht als erledigt; fremde Delegation ändert nichts', async () => {
        vi.useFakeTimers()
        const executor = await seed(vi.fn(async () => { }))
        await vi.advanceTimersByTimeAsync(5_100)
        dlg.listener!({ id: 'dlg-ffffffffffff', missionId: 'dlg-auftrag', status: 'fertig' }, { verified: true })
        expect(executor.getActiveMission()!.steps[0].status).toBe('active')
        dlg.listener!({ id: 'dlg-aaaaaaaaaaaa', missionId: 'dlg-auftrag', status: 'fertig', pruefung: { ergebnis: 'unverifiziert', detail: 'keine lesende Prüfung' } }, { verified: false })
        const step = executor.getActiveMission()!.steps[0]
        expect(step.status).toBe('failed')
        expect(executor.getActiveMission()!.progressUpdates.at(-1)).toMatch(/nicht verifiziert/)
    })

    it('geht die Übergabe nicht, macht Xaventra den Schritt selbst', async () => {
        vi.useFakeTimers()
        dlg.result = { ok: false, reason: 'Keine Agentic-OS-URL' }
        const handleMessage = vi.fn(async () => { })
        const executor = await seed(handleMessage)
        await vi.advanceTimersByTimeAsync(5_100)
        expect(dlg.calls).toHaveLength(1)
        expect(String((handleMessage.mock.calls[0] as unknown[])[2])).toContain('mache 1')
        const mission = executor.getActiveMission() ?? executor.getMissionData().history.at(-1)!
        expect(mission.progressUpdates.some(line => line.includes('Übergabe an Codex nicht möglich'))).toBe(true)
    })

    it('ohne an läuft der Schritt wie bisher lokal', async () => {
        vi.useFakeTimers()
        const handleMessage = vi.fn(async () => { })
        await seed(handleMessage, {})
        await vi.advanceTimersByTimeAsync(5_100)
        expect(dlg.calls).toHaveLength(0)
        expect(String((handleMessage.mock.calls[0] as unknown[])[2])).toContain('mache 1')
    })
})

describe('P9 Recovery-Takt nur bei wartendem Checkpoint', () => {
    async function freshExecutor() {
        vi.resetModules()
        writeFileSync(join(process.cwd(), '.nova-data', 'auftraege.json'), JSON.stringify({ active: null, history: [], queue: [] }))
        const executor = await import('./autonomous-executor.js')
        executor.initMissionEngine({ handleMessage: (async () => { }) as any, notifyFn: async () => { }, llm: null, state: {} })
        return executor
    }

    it('nichts wiederherzustellen: der 15-s-Takt hört nach dem ersten Durchlauf auf', async () => {
        const executor = await freshExecutor()
        executor.startMissionRecoveryWatcher(15_000)
        await vi.waitFor(() => expect(executor.isMissionRecoveryWatching()).toBe(false))
    })

    it('Gegenprobe: ein Checkpoint wartet auf seine Lease → der Takt läuft weiter', async () => {
        mesh.checkpoints = [{ missionId: 'm_wait', checkpoint: {} }]
        mesh.owner = false
        const executor = await freshExecutor()
        executor.startMissionRecoveryWatcher(15_000)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(executor.isMissionRecoveryWatching()).toBe(true)
        executor.stopMissionRecoveryWatcher()
    })
})
