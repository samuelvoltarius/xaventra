/**
 * 2.84.0 Punkt 1: Doctor-Untersuchungen starten warm und verbrennen keine
 * Versuche. Infrastruktur (Deadline, Abbruch, Modellfehler ohne einen
 * einzigen erfolgreichen Diagnose-Aufruf) ist kein Versuch; ein
 * Katalogaufruf ist kein Befund.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const reconcile = vi.hoisted(() => vi.fn(() => 0))
const propose = vi.hoisted(() => vi.fn(async () => undefined))
const handoffTick = vi.hoisted(() => vi.fn(async () => ({ queued: 0, delegated: 0, reconciled: 0 })))
vi.mock('../core/validator-failure-escalation.js', () => ({ reconcileValidatorFailures: reconcile }))
vi.mock('../core/autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('./repair-candidate.js', () => ({ proposeDoctorRepair: propose, reconcileDoctorRepairs: () => undefined }))
vi.mock('../synthesis/self-evolution.js', async original => ({ ...(await original<any>()), reconcileRepairActivations: async () => undefined }))
vi.mock('./claude-handoff.js', async original => ({ ...(await original<any>()), runClaudeHandoffTick: handoffTick }))
import { FailureResearchCoordinator, RESEARCH_TOOLS, setFailureResearchCoordinator, type ResearchWorker, type ResearchWorkerInput } from './failure-research-coordinator.js'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import type { DoctorFinding } from '../core/self-doctor.js'
import { DOCTOR_WARMUP_SECONDS, setAutonomyThinkCallback, setDoctorResearchWorker, triggerAutonomyCheck, updateAutonomyConfig } from '../core/autonomy-loop.js'
import { sdkFollowupTimeoutMs } from '../agents/nova-runner.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })

const HOUR = 60 * 60_000
let serial = 0
function fixture() {
    const path = join(process.cwd(), '.nova-data', `doctor-warmstart-${process.pid}-${serial++}.json`)
    const coordinator = new FailureResearchCoordinator(path)
    const ledger = new OutcomeLedger(`${path}.ledger`)
    const finding: DoctorFinding = { id: 'warmstart', title: 'Tool web_search is failing', detail: 'web_search timeout on https://example.com',
        category: 'tools', severity: 'warning', source: 'fixture', recommendation: 'Investigate', evidence: {}, status: 'open', createdAt: '', updatedAt: '' }
    coordinator.ingest(finding)
    const execute = vi.fn(async (input: ResearchWorkerInput) => {
        ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
        ledger.fail(input.contract.id, { reason: 'Error: Timeout: agent model call exceeded deadline' })
        return { output: '' }
    })
    const worker: ResearchWorker = { hasAuthority: () => true, getRun: id => ledger.getRun(id), execute }
    return { path, coordinator, ledger, worker, execute }
}

afterEach(() => { vi.restoreAllMocks(); reconcile.mockClear(); propose.mockClear(); handoffTick.mockClear() })

describe('Doctor: Aufwärmgrenze im Autonomie-Zyklus', () => {
    async function cycle(uptimeSeconds: number) {
        const f = fixture()
        setFailureResearchCoordinator(f.coordinator)
        vi.spyOn(process, 'uptime').mockReturnValue(uptimeSeconds)
        updateAutonomyConfig({ enabled: true, socialCheckIns: false, checks: { health: false, inbound: false, logs: false, uptime: false } })
        setAutonomyThinkCallback(async () => '')
        setDoctorResearchWorker(f.worker)
        await triggerAutonomyCheck()
        return f
    }

    it('60 s nach dem Start: keine Untersuchung und kein Reparatur-Entwurf; Erfassen und Übergabe laufen weiter', async () => {
        const f = await cycle(60)
        expect(f.execute).not.toHaveBeenCalled()
        expect(propose).not.toHaveBeenCalled()
        expect(reconcile).toHaveBeenCalledOnce()
        expect(handoffTick).toHaveBeenCalledOnce()
        expect(f.coordinator.list()[0].investigation).toBeUndefined()
    })

    it('Gegenprobe: nach der Aufwärmzeit wird untersucht', async () => {
        const f = await cycle(DOCTOR_WARMUP_SECONDS + 1)
        expect(DOCTOR_WARMUP_SECONDS).toBe(15 * 60)
        expect(f.execute).toHaveBeenCalledOnce()
        expect(propose).toHaveBeenCalledOnce()
    })
})

describe('Doctor: Infrastruktur ist kein Versuch', () => {
    it('dreimal Deadline ohne Werkzeug: Fall bleibt untersuchbar, attempts 0, holdReason infrastruktur, 60 min Pause', async () => {
        const f = fixture()
        let now = 1_000
        for (let i = 0; i < 3; i++) {
            const item = await f.coordinator.investigateNext(f.worker, now)
            expect(item?.investigation).toMatchObject({ status: 'failed', attempts: 0, holdReason: 'infrastruktur' })
            expect(item!.investigation!.nextAttemptAt).toBe(now + HOUR)
            // vor Ablauf der Pause: nichts
            expect(await f.coordinator.investigateNext(f.worker, now + HOUR - 1)).toBeNull()
            now += HOUR
        }
        const [item] = f.coordinator.list()
        expect(item.investigation).toMatchObject({ status: 'failed', attempts: 0, holdReason: 'infrastruktur', infraFailures: 3 })
        expect(f.execute).toHaveBeenCalledTimes(3)
    })

    it('höchstens 6 Infrastruktur-Versuche je Fall, danach sichtbar blockiert mit diesem Grund', async () => {
        const f = fixture()
        let now = 1_000
        for (let i = 0; i < 8; i++) { await f.coordinator.investigateNext(f.worker, now); now += HOUR }
        expect(f.execute).toHaveBeenCalledTimes(6)
        expect(f.coordinator.list()[0].investigation).toMatchObject({ status: 'blocked', holdReason: 'infrastruktur', infraFailures: 6 })
    })

    it('Gegenprobe: erfolgreicher health_status und abgelehnter Bericht zählt weiter als Versuch', async () => {
        const f = fixture()
        f.execute.mockImplementation(async input => {
            f.ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
            f.ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true, result: { success: true, output: 'web_search 40 Fehler' } })
            f.ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: false, awaitingApproval: false, criteria: [], violations: [] })
            f.ledger.fail(input.contract.id, { reason: 'validator-rejected' })
            return { output: 'Bericht ohne Gegenbelege' }
        })
        const item = await f.coordinator.investigateNext(f.worker, 1_000)
        expect(item?.investigation).toMatchObject({ status: 'failed', attempts: 1 })
        expect(item?.investigation?.holdReason).toBeUndefined()
    })

    it('ein Abbruch durch das Zeitlimit wird beim Nachlesen nicht doppelt gezählt', async () => {
        const f = fixture()
        await f.coordinator.investigateNext(f.worker, 1_000)
        // derselbe Lauf wird vor dem neuen Versuch noch einmal abgeglichen
        await f.coordinator.investigateNext(f.worker, 1_000 + HOUR)
        expect(f.coordinator.list()[0].investigation).toMatchObject({ attempts: 0, infraFailures: 2 })
    })
})

describe('Doctor: Diagnose ohne Katalog', () => {
    it('RESEARCH_TOOLS bietet nova_capabilities nicht an; find_capability bleibt', () => {
        expect(RESEARCH_TOOLS).not.toContain('nova_capabilities')
        expect(RESEARCH_TOOLS).toContain('find_capability')
    })

    it('ein Lauf mit nur einem Katalogaufruf ergibt nicht verified', async () => {
        const f = fixture()
        f.execute.mockImplementation(async input => {
            f.ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
            f.ledger.recordTool(input.contract.id, { toolName: 'nova_capabilities', success: true, result: { success: true, output: 'web_search, health_status, mesh_nodes' } })
            f.ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
            f.ledger.completeValidated(input.contract.id, { success: true })
            return { output: 'Es gibt diese Werkzeuge.' }
        })
        const item = await f.coordinator.investigateNext(f.worker, 1_000)
        expect(item?.investigation?.status).not.toBe('verified')
        expect(f.execute.mock.calls[0][0].contract.allowedChanges.allowedTools).not.toContain('nova_capabilities')
    })

    it('Reparatur-Entwurf bietet nova_capabilities nicht an', async () => {
        const { readFileSync } = await import('node:fs')
        const source = readFileSync(new URL('./repair-candidate.ts', import.meta.url), 'utf8')
        expect(source.includes("'health_status', 'nova_capabilities', 'read_file'")).toBe(false)
    })
})

describe('Doctor: Folge-Timeout für Diagnose-Läufe', () => {
    it('Diagnose-Lauf: 60 s statt 30 s, gedeckelt durch die Restzeit des Vertrags', () => {
        const contract = { budget: { timeoutMs: 90_000, maxToolCalls: 6, maxOutputTokens: 6_000 } }
        expect(sdkFollowupTimeoutMs(undefined, 0, 10_000)).toBe(30_000)
        expect(sdkFollowupTimeoutMs(contract, 0, 10_000)).toBe(60_000)
        expect(sdkFollowupTimeoutMs(contract, 0, 70_000)).toBe(20_000)
        expect(sdkFollowupTimeoutMs(contract, 0, 95_000)).toBe(1)
    })
})
