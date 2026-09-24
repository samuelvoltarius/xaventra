import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OutcomeLedger, type OutcomeRunView } from './outcome-ledger.js'
import { createTaskContract } from './task-contract.js'
import { detectActionIntent } from './action-intent.js'
import { FailureResearchCoordinator, RESEARCH_TOOLS } from '../doctor/failure-research-coordinator.js'
import { reconcileValidatorFailures } from './validator-failure-escalation.js'

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
    const path = mkdtempSync(join(tmpdir(), 'validator-doctor-')); paths.push(path)
    const ledger = new OutcomeLedger(join(path, 'ledger'), false)
    const contract = createTaskContract('check private URL', detectActionIntent('check private URL'), [], {
        successCriteria: [{ id: 'target', kind: 'verified_tool', required: true, description: 'private target' }],
    })
    ledger.start(contract, { userId: 'private-owner', channel: 'telegram' })
    ledger.recordValidation(contract.id, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
        success: false, awaitingApproval: false, criteria: [{ criterionId: 'target', success: false, evidence: [], reason: 'private-url-secret' }], violations: [] })
    ledger.fail(contract.id, { reason: 'validator-rejected', diagnosticEligible: true })
    const queue = join(path, 'queue.json')
    return { ledger, queue, doctor: new FailureResearchCoordinator(queue), run: ledger.getRun(contract.id)! }
}

describe('validator rejection to bounded self-diagnosis', () => {
    it('recovers a committed failure after restart, deduplicates and excludes private input', () => {
        const f = fixture()
        expect(reconcileValidatorFailures(f.ledger, f.doctor)).toBe(1)
        const restored = new FailureResearchCoordinator(f.queue)
        expect(reconcileValidatorFailures(f.ledger, restored)).toBe(0)
        const serialized = JSON.stringify(restored.list())
        expect(serialized).not.toContain('private-owner')
        expect(serialized).not.toContain('private-url-secret')
        expect(serialized).not.toContain('private target')
        expect(restored.list()[0].patchGateRequired).toBe(true)
    })

    it.each([
        { status: 'completed' }, { invalidated: true }, { userId: 'Nova-Autonomy' },
        { channel: 'internal' }, { channel: 'benchmark' }, { userId: '' },
        { finalOutcome: { reason: 'validator-rejected', diagnosticEligible: false } },
        { finalOutcome: { reason: 'policy-blocked', diagnosticEligible: true } },
    ])('does not enqueue ineligible evidence %j', override => {
        const f = fixture()
        expect(reconcileValidatorFailures({ listRuns: () => [{ ...f.run, ...override } as OutcomeRunView] }, f.doctor)).toBe(0)
    })

    it('rejects approval waits and uncorrelated validation', () => {
        const f = fixture()
        for (const validation of [
            { ...f.run.validation!, awaitingApproval: true },
            { ...f.run.validation!, success: true },
            { ...f.run.validation!, criteria: [{ criterionId: 'different', success: false, evidence: [] }] },
        ]) expect(reconcileValidatorFailures({ listRuns: () => [{ ...f.run, validation }] }, f.doctor)).toBe(0)
    })

    it('separates principals and bounds intake', () => {
        const f = fixture()
        const runs = Array.from({ length: 12 }, (_, i) => ({ ...f.run, userId: `owner-${i}` }))
        expect(reconcileValidatorFailures({ listRuns: () => runs }, f.doctor)).toBe(10)
        expect(reconcileValidatorFailures({ listRuns: () => runs }, f.doctor)).toBe(2)
        expect(f.doctor.list()).toHaveLength(12)
    })

    it('uses the existing fenced worker and terminal receipt without replaying the original request', async () => {
        const f = fixture()
        reconcileValidatorFailures(f.ledger, f.doctor)
        const execute = vi.fn(async ({ contract, content }) => {
            expect(contract.allowedChanges.readOnly).toBe(true)
            expect(contract.allowedChanges.allowedTools.every(name => RESEARCH_TOOLS.includes(name))).toBe(true)
            expect(content).not.toContain('private-owner')
            f.ledger.start(contract, { userId: 'Nova-Autonomy', channel: 'internal' })
            f.ledger.recordTool(contract.id, { toolName: 'mesh_nodes', success: true, result: { success: true, output: 'Controlled node fixture' } })
            f.ledger.recordValidation(contract.id, { validator: 'nova-execution-kernel', validatedAt: '', success: true, awaitingApproval: false, criteria: [], violations: [] })
            f.ledger.completeValidated(contract.id, { success: true })
            return { output: 'Fixture diagnosis, not a repair.' }
        })
        const worker = { hasAuthority: () => false, getRun: id => f.ledger.getRun(id), execute }
        expect(await f.doctor.investigateNext(worker)).toBeNull()
        expect(execute).not.toHaveBeenCalled()
        worker.hasAuthority = () => true
        expect((await f.doctor.investigateNext(worker))?.investigation?.status).toBe('verified')
        const restored = new FailureResearchCoordinator(f.queue)
        expect(reconcileValidatorFailures(f.ledger, restored)).toBe(0)
        expect(await restored.investigateNext(worker)).toBeNull()
        expect(execute).toHaveBeenCalledTimes(1)
        expect(restored.list()[0].stage).not.toBe('resolved')
    })
})
