import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { OutcomeRouter } from './outcome-router.js'

describe('OutcomeRouter', () => {
    it('reports validated training coverage without benchmark contamination', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-router-'))
        const ledger = new OutcomeLedger(join(dir, 'ledger'))
        const router = new OutcomeRouter(ledger, join(dir, 'decisions.jsonl'), 'shadow')
        const status = router.getTrainingStatus()
        expect(status.mode).toBe('shadow')
        expect(status.minimumSamples).toBeGreaterThanOrEqual(10)
        expect(status.cells).toEqual([])
    })
    it('evaluates alternatives without changing the selected route in shadow mode', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-router-'))
        const router = new OutcomeRouter(new OutcomeLedger(join(dir, 'ledger')), join(dir, 'decisions.jsonl'), 'shadow')
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }])
        expect(decision.mode).toBe('shadow')
        expect(decision.selected.model).toBe('configured')
        expect(decision.recommended.model).toBe('candidate')
        expect(decision.activationEligible).toBe(false)
    })

    it('keeps active routing closed until enough validated successes exist', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-router-'))
        const ledger = new OutcomeLedger(join(dir, 'ledger'))
        const router = new OutcomeRouter(ledger, join(dir, 'decisions.jsonl'), 'active')
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }])
        expect(decision.selected.model).toBe('configured')
        expect(decision.activationEligible).toBe(false)
        expect(decision.reasons.join(' ')).toContain('activation gate closed')
    })

    it('activates only from task-specific validated outcomes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-router-'))
        const ledger = new OutcomeLedger(join(dir, 'ledger'))
        for (let index = 0; index < 20; index++) {
            const runId = `run-${index}`
            ledger.append(runId, 'route.selected', { model: 'candidate', node: 'spark', taskType: 'coding' })
            ledger.append(runId, 'validation.finished', { validation: { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(), success: true, awaitingApproval: false, criteria: [], violations: [] } })
            ledger.complete(runId, { durationMs: 100 })
        }
        const router = new OutcomeRouter(ledger, join(dir, 'decisions.jsonl'), 'active')
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }])
        expect(decision.activationEligible).toBe(true)
        expect(decision.selected.model).toBe('candidate')
    })

    it('never trains active routing from benchmark fixtures', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-router-'))
        const ledger = new OutcomeLedger(join(dir, 'ledger'))
        for (let index = 0; index < 20; index++) {
            const runId = `benchmark-run-${index}`
            ledger.append(runId, 'run.started', { channel: 'benchmark', userId: `benchmark:coding-${index}` })
            ledger.append(runId, 'route.selected', { model: 'candidate', node: 'spark', taskType: 'coding' })
            ledger.append(runId, 'validation.finished', { validation: { validator: 'nova-execution-kernel', validatedAt: new Date().toISOString(), success: true, awaitingApproval: false, criteria: [], violations: [] } })
            ledger.complete(runId, { durationMs: 100 })
        }
        const router = new OutcomeRouter(ledger, join(dir, 'decisions.jsonl'), 'active')
        const decision = router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }])
        expect(decision.activationEligible).toBe(false)
        expect(decision.selected.model).toBe('configured')
    })
})
