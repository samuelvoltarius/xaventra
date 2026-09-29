import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    getOutcomeLedger,
    OutcomeLedger,
    recordFeedbackForLatestUserRun,
    type OutcomeCheckpoint,
    type OutcomeEvent,
    withOutcomeLedger,
} from './outcome-ledger.js'
import { createTaskContract, validateTaskCompletion } from './task-contract.js'
import { RegressionCaseStore, getRegressionCaseStore, setRegressionCaseStore } from '../learning/regression-case-store.js'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('OutcomeLedger', () => {
    it('refuses terminal success until a successful non-pending validation is persisted', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-authority-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        const contract = createTaskContract('Answer safely', { requiresTool: false, kind: 'none' })
        ledger.start(contract, { channel: 'test', userId: 'owner' })

        expect(ledger.completeValidated(contract.id, { success: true })).toBe(false)
        expect(ledger.getRun(contract.id)?.status).toBe('running')
        ledger.recordValidation(contract.id, {
            validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(),
            success: false, awaitingApproval: false, criteria: [], violations: ['fixture rejection'],
        })
        expect(ledger.completeValidated(contract.id, { success: true })).toBe(false)
        expect(ledger.getRun(contract.id)?.status).toBe('running')
        ledger.recordValidation(contract.id, {
            validator: 'model-self-check', validatedAt: new Date().toISOString(),
            success: true, awaitingApproval: false, criteria: [], violations: [],
        } as any)
        expect(ledger.completeValidated(contract.id, { success: true })).toBe(false)
        expect(ledger.getRun(contract.id)?.status).toBe('running')
    })

    it('rebuilds a run from immutable events without production data', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-ledger-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir)
        const contract = createTaskContract('Erkläre etwas', { requiresTool: false, kind: 'none' })
        ledger.start(contract, { channel: 'test', userId: 'test-user', backend: 'nova' })
        ledger.recordRoute(contract.id, { backend: 'nova', model: 'test-model', node: 'test-node' })
        const validation = validateTaskCompletion(contract, { response: 'Antwort' })
        ledger.recordValidation(contract.id, validation)
        ledger.completeValidated(contract.id, { success: true })

        const run = ledger.getRun(contract.id)
        expect(run?.status).toBe('completed')
        expect(run?.validation?.success).toBe(true)
        expect(run?.model).toBe('test-model')
    })

    it('keeps a verified model and node when later route telemetry omits placement', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-route-placement-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        const contract = createTaskContract('Use Spark tools', { requiresTool: true, kind: 'generic-action' })
        ledger.start(contract, { channel: 'desktop', userId: 'owner' })
        ledger.recordRoute(contract.id, { backend: 'local-vllm', model: 'qwen', node: 'nova-spark' })
        ledger.recordRoute(contract.id, { backend: 'nova', reason: 'shadow router observation' })
        ledger.recordValidation(contract.id, validateTaskCompletion(contract, { response: 'completed', verifiedTools: ['run_command'] }))
        ledger.completeValidated(contract.id, { success: true })

        expect(ledger.getRun(contract.id)).toMatchObject({
            model: 'qwen', node: 'nova-spark', backend: 'nova',
        })
    })

    it('attaches explicit user feedback only to that principal latest completed run', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-feedback-outcome-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        const sample = createTaskContract('Sample task', { requiresTool: false, kind: 'none' })
        const sampleTwo = createTaskContract('Sample Two task', { requiresTool: false, kind: 'none' })
        ledger.start(sample, { channel: 'telegram', userId: 'sample' })
        ledger.recordValidation(sample.id, validateTaskCompletion(sample, { response: 'done' }))
        ledger.completeValidated(sample.id, { success: true })
        ledger.start(sampleTwo, { channel: 'telegram', userId: 'sample-two' })
        ledger.recordValidation(sampleTwo.id, validateTaskCompletion(sampleTwo, { response: 'done' }))
        ledger.completeValidated(sampleTwo.id, { success: true })

        expect(recordFeedbackForLatestUserRun({
            userId: 'sample',
            channel: 'telegram',
            rating: 5,
            accepted: true,
            comment: 'perfekt',
        }, ledger)).toBe(sample.id)
        expect(ledger.getRun(sample.id)?.feedback).toHaveLength(1)
        expect(ledger.getRun(sampleTwo.id)?.feedback).toHaveLength(0)
    })

    it('quarantines a real negative user correction as a regression candidate', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-ledger-feedback-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(join(dir, 'ledger'), false)
        setRegressionCaseStore(new RegressionCaseStore(join(dir, 'regressions.json')))
        const contract = createTaskContract('Prüfe Spark', { requiresTool: false, kind: 'none' })
        ledger.start(contract, { channel: 'telegram', userId: 'sample', backend: 'nova' })
        ledger.recordValidation(contract.id, validateTaskCompletion(contract, { response: 'checked' }))
        ledger.completeValidated(contract.id, { success: true })

        expect(recordFeedbackForLatestUserRun({
            userId: 'sample', channel: 'telegram', accepted: false,
            correction: 'Spark ist nicht erreichbar',
        }, ledger)).toBe(contract.id)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(getRegressionCaseStore().list('sample')[0]?.status).toBe('quarantined')
        expect(getRegressionCaseStore().list('sample')).toHaveLength(1)
        expect(ledger.getRun(contract.id)).toMatchObject({ status: 'failed', invalidated: true })
        expect(recordFeedbackForLatestUserRun({
            userId: 'sample', channel: 'telegram', accepted: false,
            correction: 'same correction again',
        }, ledger)).toBeNull()
    })

    it('persists resumable checkpoints in the isolated store', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-checkpoint-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir)
        ledger.saveCheckpoint({
            runId: 'run-1', backend: 'openai-agents', backendState: '{"state":1}',
            phase: 'awaiting_approval', pendingActions: ['write_file'], completedIdempotencyKeys: ['read:1'],
        })
        expect(ledger.loadCheckpoint('run-1')).toMatchObject({
            runId: 'run-1', phase: 'awaiting_approval', pendingActions: ['write_file'],
        })
    })

    it('reconciles stale running outcomes without discarding approval checkpoints', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-stale-outcomes-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir)
        const contract = createTaskContract('stale run', { requiresTool: false, kind: 'none' })
        ledger.start(contract, { channel: 'test' })
        const failed = ledger.failStaleRuns(1_000, Date.now() + 2_000)
        expect(failed).toContain(contract.id)
        expect(ledger.getRun(contract.id)?.status).toBe('failed')
    })

    it('imports mirrored events and checkpoints idempotently', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-imported-outcomes-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir)
        const timestamp = new Date().toISOString()
        const events: OutcomeEvent[] = [{
            version: 1, eventId: 'event-1', runId: 'run-imported', type: 'validation.finished',
            timestamp, payload: { validation: { validator: 'nova-execution-kernel', validatedAt: timestamp, success: true, awaitingApproval: false, criteria: [], violations: [] } },
        }, {
            version: 1, eventId: 'event-2', runId: 'run-imported', type: 'run.completed',
            timestamp, payload: { success: true },
        }]
        expect(ledger.importEvents([...events, events[1]])).toBe(2)
        expect(ledger.getRun('run-imported')?.status).toBe('completed')

        const checkpoint: OutcomeCheckpoint = {
            version: 1, runId: 'run-imported', backend: 'nova', phase: 'resume',
            pendingActions: ['next'], completedIdempotencyKeys: ['done'], savedAt: new Date().toISOString(),
        }
        expect(ledger.importCheckpoint(checkpoint)).toBe(true)
        expect(ledger.importCheckpoint(checkpoint)).toBe(false)
        expect(ledger.loadCheckpoint('run-imported')?.pendingActions).toEqual(['next'])
    })

    it('fails closed when an imported terminal success has no validator event', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-imported-unvalidated-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        ledger.importEvent({
            version: 1, eventId: 'terminal-only', runId: 'unvalidated', type: 'run.completed',
            timestamp: new Date().toISOString(), payload: { success: true },
        })
        expect(ledger.getRun('unvalidated')).toMatchObject({ status: 'failed', invalidated: true })
    })

    it('keeps asynchronous benchmark ledgers isolated from concurrent scopes', async () => {
        const firstDir = mkdtempSync(join(tmpdir(), 'nova-scoped-outcome-a-'))
        const secondDir = mkdtempSync(join(tmpdir(), 'nova-scoped-outcome-b-'))
        tempDirs.push(firstDir, secondDir)
        const first = new OutcomeLedger(firstDir, false)
        const second = new OutcomeLedger(secondDir, false)

        const [firstResolved, secondResolved] = await Promise.all([
            withOutcomeLedger(first, async () => {
                await Promise.resolve()
                return getOutcomeLedger()
            }),
            withOutcomeLedger(second, async () => {
                await new Promise(resolve => setTimeout(resolve, 1))
                return getOutcomeLedger()
            }),
        ])

        expect(firstResolved).toBe(first)
        expect(secondResolved).toBe(second)
        expect(firstResolved).not.toBe(secondResolved)
    })
})

describe('periodic stale sweep keeps live runs (R2 NZ-14)', () => {
    it('does not fail a quiet run of this process or a peer run when keepLiveRuns is set', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-live-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        const contract = createTaskContract('long build', { requiresTool: false, kind: 'none' })
        ledger.start(contract, { channel: 'test' })
        const timestamp = new Date().toISOString()
        ledger.importEvents([{ version: 1, eventId: 'peer-1', runId: 'peer-run', type: 'run.started', timestamp, payload: {} }])

        expect(ledger.failStaleRuns(1_000, Date.now() + 20 * 60_000, { keepLiveRuns: true })).toEqual([])
        expect(ledger.getRun(contract.id)?.status).toBe('running')
        expect(ledger.getRun('peer-run')?.status).toBe('running')

        // Crash reconciliation by a fresh process still closes abandoned runs.
        const restarted = new OutcomeLedger(dir, false)
        expect(restarted.failStaleRuns(1_000, Date.now() + 20 * 60_000, { keepLiveRuns: true }).sort()).toEqual([contract.id, 'peer-run'].sort())
    })
})

describe('checkpoint runId path safety (R2 NZ-4)', () => {
    it('rejects mesh checkpoints whose runId escapes the checkpoint directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-runid-'))
        tempDirs.push(dir)
        // Ledger two levels below dir: "../../victim" would land at dir/victim.json.
        const ledger = new OutcomeLedger(join(dir, 'ledger'), false)
        for (const runId of ['../../victim', '..\\..\\victim', 'a/b', '..', '']) {
            const checkpoint = { version: 1, runId, backend: 'native', savedAt: new Date().toISOString() } as unknown as OutcomeCheckpoint
            expect(ledger.importCheckpoint(checkpoint), runId).toBe(false)
            expect(ledger.loadCheckpoint(runId), runId).toBeNull()
        }
        expect(existsSync(join(dir, 'victim.json'))).toBe(false)
        expect(() => ledger.saveCheckpoint({ runId: '../escape', backend: 'native' } as any)).toThrow()
    })

    it('still accepts normal run ids', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-outcome-runid-ok-'))
        tempDirs.push(dir)
        const ledger = new OutcomeLedger(dir, false)
        const checkpoint = { version: 1, runId: 'native-0123abcd', backend: 'native', savedAt: new Date().toISOString() } as unknown as OutcomeCheckpoint
        expect(ledger.importCheckpoint(checkpoint)).toBe(true)
        expect(ledger.loadCheckpoint('native-0123abcd')?.runId).toBe('native-0123abcd')
    })
})
