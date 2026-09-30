import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FailureResearchCoordinator, observationFingerprint, type ResearchWorker, type ResearchWorkerInput } from './failure-research-coordinator.js'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import type { DoctorFinding } from '../core/self-doctor.js'
import { sdkTurnLimit } from '../agents/nova-runner.js'

const runNovaAgent = vi.hoisted(() => vi.fn(async (_params: any) => ({ content: 'report' })))
vi.mock('../agents/nova-runner.js', async original => ({ ...(await original() as object), runNovaAgent }))

let serial = 0
function trace(detail: string): DoctorFinding {
    return { id: 'doctor_trace_rate', title: 'Trace success rate is below target', detail,
        category: 'performance', severity: 'critical', source: 'trace-analyzer', recommendation: 'Investigate', evidence: {}, status: 'open', createdAt: '', updatedAt: '' }
}
function verifiedWorker() {
    const path = join(process.cwd(), '.nova-data', `research-stufe1-${process.pid}-${serial++}.json`)
    const ledger = new OutcomeLedger(`${path}.ledger`)
    const execute = vi.fn(async (input: ResearchWorkerInput) => {
        ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
        ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true, result: { success: true, output: 'Observed' } })
        ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
        ledger.completeValidated(input.contract.id, { success: true })
        return { output: 'verified diagnosis' }
    })
    const worker: ResearchWorker = { hasAuthority: () => true, getRun: id => ledger.getRun(id), execute }
    return { coordinator: new FailureResearchCoordinator(path), worker, execute }
}

describe('Doctor Stufe 1: no endless re-investigation', () => {
    it('keeps a verified case when only the measured numbers change (live: 35 runs of one case)', async () => {
        const f = verifiedWorker()
        f.coordinator.ingest(trace('Success rate is 7.0% across 748 traces.'))
        expect((await f.coordinator.investigateNext(f.worker, 1))?.investigation?.status).toBe('verified')
        f.coordinator.ingest(trace('Success rate is 6.4% across 812 traces.'))
        expect(await f.coordinator.investigateNext(f.worker, 10 * 3_600_000)).toBeNull()
        expect(f.execute).toHaveBeenCalledTimes(1)
    })

    it('still investigates again when the kind of fault changes', async () => {
        const f = verifiedWorker()
        f.coordinator.ingest(trace('Success rate is 7.0% across 748 traces.'))
        await f.coordinator.investigateNext(f.worker, 1)
        f.coordinator.ingest(trace('Trace store unreadable: permission denied.'))
        expect((await f.coordinator.investigateNext(f.worker, 10 * 3_600_000))?.investigation?.status).toBe('verified')
        expect(f.execute).toHaveBeenCalledTimes(2)
    })

    it('ignores counts, clock times and ids but not words', () => {
        const base = { title: 'Models auto-disabled', source: 's', category: 'c' }
        expect(observationFingerprint({ ...base, detail: 'qwen: 40 consecutive failures (re-enables at 12:40:09 PM), run 7ba2101f93d916b4' }))
            .toBe(observationFingerprint({ ...base, detail: 'qwen: 6 consecutive failures (re-enables at 6:40:10 PM), run 0a2a4775e4c52e12' }))
        expect(observationFingerprint({ ...base, detail: 'qwen: 6 consecutive failures' }))
            .not.toBe(observationFingerprint({ ...base, detail: 'ornith: 6 consecutive failures' }))
    })
})

describe('Doctor Stufe 1: diagnosis runs are isolated', () => {
    it('the research worker marks its runs as diagnostic', async () => {
        const { createResearchWorker } = await import('./research-worker.js')
        const worker = createResearchWorker(() => true)
        const contract: any = { id: 'doctor-research-x', allowedChanges: { allowedTools: ['health_status'], allowedPaths: [], readOnly: true, externalSideEffects: false }, budget: { maxToolCalls: 6 } }
        await worker.execute({ contract, content: 'x', caseId: 'c', signal: new AbortController().signal })
        expect(runNovaAgent).toHaveBeenCalledTimes(1)
        expect(runNovaAgent.mock.calls[0][0]).toMatchObject({ diagnostic: true, userId: 'Nova-Autonomy', channel: 'internal' })
    })

    it('gives a diagnosis the turns its contract grants, other runs keep the configured limit', () => {
        expect(sdkTurnLimit(3)).toBe(4)
        expect(sdkTurnLimit(3, { budget: { maxToolCalls: 6 } } as any)).toBe(7)
        expect(sdkTurnLimit(50, { budget: { maxToolCalls: 6 } } as any)).toBe(51)
        expect(sdkTurnLimit(Number.NaN)).toBe(51)
    })
})
