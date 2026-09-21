import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { createTaskContract } from '../core/task-contract.js'
import { OutcomeRouter } from './outcome-router.js'

function fixture(mode: 'shadow' | 'active' = 'shadow') {
    const dir = mkdtempSync(join(tmpdir(), 'xaventra-router-'))
    const ledger = new OutcomeLedger(join(dir, 'ledger'))
    return { dir, ledger, router: new OutcomeRouter(ledger, join(dir, 'decisions.jsonl'), mode, join(dir, 'samples.json')) }
}

function record(router: OutcomeRouter, index: number, overrides: Partial<Parameters<OutcomeRouter['recordValidatedSample']>[0]> = {}) {
    return router.recordValidatedSample({
        runId: `run-${index}`, userId: 'alice', channel: 'telegram', taskType: 'coding', model: 'candidate', node: 'spark',
        success: true, durationMs: 100, costUsd: 0.001, validatedAt: new Date().toISOString(),
        validationSource: 'nova-execution-kernel', evidenceRefs: [`tool-call:call-${index}:read_file`], ...overrides,
    })
}

describe('OutcomeRouter', () => {
    it('reports empty validated training coverage initially', () => {
        const { router } = fixture()
        const status = router.getTrainingStatus('alice')
        expect(status.mode).toBe('shadow')
        expect(status.scope).toBe('principal')
        expect(status.minimumSamples).toBeGreaterThanOrEqual(10)
        expect(status.cells).toEqual([])
    })

    it('evaluates alternatives without changing the selected route in shadow mode', () => {
        const { router } = fixture('shadow')
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }], { userId: 'alice', channel: 'telegram' })
        expect(decision.mode).toBe('shadow')
        expect(decision.selected.model).toBe('configured')
        expect(decision.recommended.model).toBe('candidate')
        expect(decision.activationEligible).toBe(false)
    })

    it('keeps active routing closed without a principal-scoped sample set', () => {
        const { router } = fixture('active')
        for (let index = 0; index < 20; index++) record(router, index)
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }])
        expect(decision.selected.model).toBe('configured')
        expect(decision.activationEligible).toBe(false)
        expect(decision.reasons.join(' ')).toContain('activation gate closed')
    })

    it('persists and activates only principal-scoped independently evidenced samples', () => {
        const { dir, ledger, router } = fixture('active')
        for (let index = 0; index < 20; index++) expect(record(router, index)).toBe(true)
        const restarted = new OutcomeRouter(ledger, join(dir, 'decisions-2.jsonl'), 'active', join(dir, 'samples.json'))
        const alice = restarted.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }], { userId: 'alice', channel: 'telegram' })
        const bob = restarted.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }], { userId: 'bob', channel: 'telegram' })
        expect(alice.activationEligible).toBe(true)
        expect(alice.selected.model).toBe('candidate')
        expect(bob.activationEligible).toBe(false)
        expect(bob.selected.model).toBe('configured')
    })

    it('rejects benchmark, synthetic and model-response-only samples', () => {
        const { router } = fixture('active')
        expect(record(router, 1, { channel: 'benchmark' })).toBe(false)
        expect(record(router, 2, { userId: 'synthetic:fixture' })).toBe(false)
        expect(record(router, 3, { evidenceRefs: ['response', 'current-turn-output-contract'] })).toBe(false)
        expect(router.getTrainingStatus('alice').cells).toEqual([])
    })

    it('does not train from self-asserted ledger terminal events', () => {
        const { ledger, router } = fixture('active')
        for (let index = 0; index < 20; index++) {
            const contract = createTaskContract(`self asserted ${index}`, { requiresTool: false, kind: 'none' })
            const runId = contract.id
            ledger.start(contract, { channel: 'telegram', userId: 'alice' })
            ledger.recordRoute(runId, { model: 'candidate', node: 'spark', taskType: 'coding' })
            ledger.recordValidation(runId, { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(), success: true, awaitingApproval: false, criteria: [], violations: [] })
            ledger.completeValidated(runId, { success: true, durationMs: 1 })
        }
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }], { userId: 'alice', channel: 'telegram' })
        expect(decision.activationEligible).toBe(false)
        expect(decision.selected.model).toBe('configured')
    })

    it('tombstones a rejected sample without affecting another principal', () => {
        const { router } = fixture('active')
        expect(record(router, 1)).toBe(true)
        expect(record(router, 2, { userId: 'bob' })).toBe(true)
        expect(router.invalidateValidatedSample('run-1', 'alice', 'user correction')).toBe(true)
        expect(router.getTrainingStatus('alice').cells).toEqual([])
        expect(router.getTrainingStatus('bob').cells[0]?.samples).toBe(1)
    })

    it('fails closed when persisted sample evidence is modified', () => {
        const { dir, ledger, router } = fixture('active')
        expect(record(router, 1)).toBe(true)
        const file = join(dir, 'samples.json')
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        parsed.samples[0].success = false
        writeFileSync(file, JSON.stringify(parsed))
        const restarted = new OutcomeRouter(ledger, join(dir, 'decisions-2.jsonl'), 'active', file)
        expect(restarted.getTrainingStatus('alice').cells).toEqual([])
    })
})
