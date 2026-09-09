import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FailureResearchCoordinator, type ResearchWorker } from './failure-research-coordinator.js'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { proposeDoctorRepair } from './repair-candidate.js'

const boundary = vi.hoisted(() => ({ evolve: vi.fn(), profiles: vi.fn() }))
vi.mock('../synthesis/self-evolution.js', () => ({ evolve: boundary.evolve, getRepairProfiles: boundary.profiles, getPatchProposals: () => [], getRepairSourceRoot: () => process.cwd() }))
async function fixture(output: string | string[] = JSON.stringify({ description: 'fix value', search: '= 1', replace: '= 2', reason: 'observed wrong answer' })) {
    const root = process.cwd(), id = randomUUID(), coordinator = new FailureResearchCoordinator(join(root, `${id}.json`)), ledger = new OutcomeLedger(join(root, `${id}.ledger`))
    mkdirSync(join(root, 'src'), { recursive: true }); writeFileSync(join(root, 'src/value.ts'), 'export const value = 1'); writeFileSync(join(root, 'src/value.test.ts'), 'oracle unchanged')
    boundary.profiles.mockReturnValue([{ id: 'value', findingId: id, file: 'src/value.ts', reproductionTest: 'src/value.test.ts', probeId: 'value', targetId: 'fixture' }])
    boundary.evolve.mockReset().mockResolvedValue({ queued: true, success: false, proposalId: 'patch-fixture' })
    let candidateIndex = 0
    const worker: ResearchWorker = { hasAuthority: () => true, getRun: id => ledger.getRun(id), execute: vi.fn(async input => {
        ledger.start(input.contract, { userId: 'Nova-Autonomy', channel: 'internal' })
        ledger.recordTool(input.contract.id, { toolName: 'health_status', success: true, result: { success: true, output: 'value:1' } })
        ledger.recordValidation(input.contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
        ledger.complete(input.contract.id, { success: true })
        return { output: input.purpose === 'candidate' ? (Array.isArray(output) ? output[Math.min(candidateIndex++, output.length - 1)] : output) : 'observed value:1, expected2' }
    }) }
    coordinator.ingest({ id, title: 'Wrong answer', detail: 'Expected 2', source: 'fixture', category: 'tools', severity: 'critical', recommendation: '', evidence: {}, status: 'open', createdAt: '', updatedAt: '' })
    await coordinator.investigateNext(worker)
    return { coordinator, worker }
}
describe('Doctor patch generation / scripted Kernel receipts and sandbox boundary', () => {
    it('generates a scoped candidate, passes immutable oracle and never grants apply', async () => {
        const f = await fixture(); await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).toHaveBeenCalledWith(expect.objectContaining({ file: 'src/value.ts', reproductionTest: 'src/value.test.ts', repairProfileId: 'value', search: '= 1', replace: '= 2' }))
        expect(boundary.evolve.mock.calls[0][0]).not.toHaveProperty('apply')
        const candidateInput = vi.mocked(f.worker.execute).mock.calls.find(([input]) => input.purpose === 'candidate')![0]
        expect(candidateInput.content).toContain('immutableReproduction')
        expect(candidateInput.content).toContain('oracle unchanged')
        expect(f.coordinator.list()[0]).toMatchObject({ stage: 'awaiting-patch-gate', repair: { status: 'queued' }, findingOpen: true })
        await proposeDoctorRepair(f.coordinator, f.worker); expect(boundary.evolve).toHaveBeenCalledOnce()
    })
    it('does not turn model-provided file, command or approval into authority', async () => {
        for (const extra of [{ file: '.env' }, { apply: true }, { approvalToken: 'invented' }, { command: 'echo danger' }]) {
            const f = await fixture(JSON.stringify({ description: 'fix', search: '= 1', replace: '= 2', reason: 'test', ...extra }))
            await proposeDoctorRepair(f.coordinator, f.worker)
            expect(boundary.evolve).not.toHaveBeenCalled(); expect(f.coordinator.list()[0].repair?.status).toBe('blocked')
        }
    })
    it('rejects prose, no-op and ambiguous search', async () => {
        for (const output of ['Fixed!', JSON.stringify({ description: 'fix', search: '', replace: '2', reason: 'test' }), JSON.stringify({ description: 'fix', search: '= 1', replace: '= 1', reason: 'test' })]) {
            const f = await fixture(output); await proposeDoctorRepair(f.coordinator, f.worker); expect(boundary.evolve).not.toHaveBeenCalled()
        }
    })
    it('cannot resolve from an arbitrary successful evidence string', async () => {
        const f = await fixture(), item = f.coordinator.list()[0]
        expect(f.coordinator.advance(item.id, 'resolved', 'model:everything-fixed', { patchGateApproved: true })).toBeNull()
    })
    it('keeps failure visible when isolated verification fails', async () => {
        const f = await fixture(); boundary.evolve.mockResolvedValue({ success: false, error: 'rollback failed' })
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(f.coordinator.list()[0]).toMatchObject({ findingOpen: true, stage: 'researching', repair: { status: 'blocked' } })
    })
    it('requires a registered operator profile', async () => {
        const f = await fixture(); boundary.profiles.mockReturnValue([])
        await proposeDoctorRepair(f.coordinator, f.worker); expect(boundary.evolve).not.toHaveBeenCalled()
    })
    it('refuses a reproduction changed while the model was generating', async () => {
        const f = await fixture(), execute = f.worker.execute
        f.worker.execute = async input => {
            const result = await execute(input)
            if (input.purpose === 'candidate') writeFileSync(join(process.cwd(), 'src/value.test.ts'), 'changed oracle')
            return result
        }
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).not.toHaveBeenCalled()
        expect(f.coordinator.list()[0].repair?.reason).toContain('reproduction changed')
    })
    it('regenerates the observed extra-reasoning response once without stripping fields or weakening approval', async () => {
        const patch = { description: 'fix', search: '= 1', replace: '= 2', reason: 'observed value mismatch' }
        const f = await fixture([JSON.stringify({ ...patch, reasoning: patch.reason }), JSON.stringify(patch)])
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).toHaveBeenCalledOnce()
        expect(boundary.evolve.mock.calls[0][0]).not.toHaveProperty('reasoning')
        const repair = f.coordinator.list()[0].repair!
        expect(repair.status).toBe('queued')
        expect(repair.attempts!.map(a => a.status)).toEqual(['format-rejected', 'accepted'])
        expect(new Set(repair.attempts!.map(a => a.runId)).size).toBe(2)
        const calls = vi.mocked(f.worker.execute).mock.calls.filter(([i]) => i.purpose === 'candidate')
        expect(calls).toHaveLength(2)
        expect(calls[1][0].content).toContain('NICHT übernommen')
        expect(calls.every(([i]) => i.contract.allowedChanges.readOnly && i.contract.approvalPolicy.patchGateRequired)).toBe(true)
    })
    it('retains both schema failures and stops after one retry', async () => {
        const f = await fixture(JSON.stringify({ description: 'fix', search: '= 1', replace: '= 2', reason: 'x', reasoning: 'x' }))
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).not.toHaveBeenCalled()
        expect(f.coordinator.list()[0].repair).toMatchObject({ status: 'blocked', attempts: [{ status: 'format-rejected' }, { status: 'format-rejected' }] })
        expect(vi.mocked(f.worker.execute).mock.calls.filter(([i]) => i.purpose === 'candidate')).toHaveLength(2)
    })
    it('does not retry when a patch also supplies authority fields', async () => {
        const f = await fixture(JSON.stringify({ description: 'fix', search: '= 1', replace: '= 2', reason: 'x', reasoning: 'x', apply: true }))
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).not.toHaveBeenCalled()
        expect(vi.mocked(f.worker.execute).mock.calls.filter(([i]) => i.purpose === 'candidate')).toHaveLength(1)
    })
    it('refuses regeneration if the source changed during the rejected attempt', async () => {
        const f = await fixture(JSON.stringify({ description: 'fix', search: '= 1', replace: '= 2', reason: 'x', reasoning: 'x' })), execute = f.worker.execute
        f.worker.execute = async input => { const r = await execute(input); if (input.purpose === 'candidate') writeFileSync(join(process.cwd(), 'src/value.ts'), 'changed source'); return r }
        await proposeDoctorRepair(f.coordinator, f.worker)
        expect(boundary.evolve).not.toHaveBeenCalled()
        expect(f.coordinator.list()[0].repair?.reason).toContain('changed before candidate generation')
    })
})
