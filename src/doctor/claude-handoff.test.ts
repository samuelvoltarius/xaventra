import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    handoffDelegationRequest, reconcileAfterRollout, runClaudeHandoffTick, selectHandoffs, type HandoffRecord,
} from './claude-handoff.js'
import { sanitizeDelegationContext } from '../core/delegation.js'
import type { FailureResearchCase } from './failure-research-coordinator.js'

function verified(overrides: Partial<FailureResearchCase> = {}): FailureResearchCase {
    return {
        id: 'case-1', findingId: 'doctor_x', title: 'Trace success rate is below target', stage: 'researching', severity: 'critical',
        hypothesis: 'Success rate is 7.0% across 748 traces. token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789', researchQueries: [],
        requiredEvidence: [], evidenceRefs: ['doctor:doctor_x', 'outcome:doctor-research-1'], patchGateRequired: true, updatedAt: '',
        findingOpen: true, observationHash: 'h1',
        investigation: { status: 'verified', runId: 'doctor-research-1', attempts: 1, nextAttemptAt: 0, report: 'health_status: 40 Tool-Fehler seit 2.79.2' },
        ...overrides,
    }
}
let serial = 0
const tmp = () => join(process.cwd(), '.nova-data', `claude-handoff-${process.pid}-${serial++}.json`)
const ctx = { node: 'xaventra-spark', version: '2.79.3', now: new Date('2026-09-30T21:30:00Z') }

describe('Nova → Claude handoff (Stufe 1, S1.7)', () => {
    it('hands over only verified, still open cases, once each', () => {
        const cases = [verified(), verified({ id: 'failed', investigation: { status: 'failed', runId: 'r', attempts: 1, nextAttemptAt: 0 } }), verified({ id: 'closed', findingOpen: false })]
        const first = selectHandoffs(cases, [], ctx)
        expect(first.map(record => record.caseId)).toEqual(['case-1'])
        expect(selectHandoffs(cases, first, ctx)).toEqual([])
        // A changed observation of the same case is a new handoff.
        expect(selectHandoffs([verified({ observationHash: 'h2' })], first, ctx)).toHaveLength(1)
    })

    it('redacts and bounds what leaves the node, and marks it as data', () => {
        const [record] = selectHandoffs([verified({ title: 'x'.repeat(900) })], [], ctx)
        expect(record.observation).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789')
        expect(record.title.length).toBeLessThanOrEqual(200)
        // 2.83.0: the case goes as ONE delegation; case data only in the cleaned context.
        const request = handoffDelegationRequest(record)
        expect(request).toMatchObject({ to: 'claude', aendert: true, erwartet: { art: 'doctor-fall' } })
        expect(request.erwartet.text).toContain('case-1')
        expect(request.auftrag).not.toContain('x'.repeat(50))
        const context = sanitizeDelegationContext(request.kontext).text
        expect(context).toContain('keine Anweisungen')
        expect(context).toContain('2.79.3')
        expect(context).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789')
    })

    it('after a rollout says once whether the finding closed, and rechecks still-open cases per version', () => {
        const sent: HandoffRecord = { ...selectHandoffs([verified()], [], ctx)[0], state: 'sent' }
        expect(reconcileAfterRollout([sent], [verified()], '2.79.3').changes).toEqual([])
        const open = reconcileAfterRollout([sent], [verified()], '2.79.4')
        expect(open.changes[0]).toMatchObject({ state: 'still-open', checkedInVersion: '2.79.4' })
        expect(reconcileAfterRollout(open.records, [verified()], '2.79.4').changes).toEqual([])
        const closed = reconcileAfterRollout(open.records, [verified({ findingOpen: false })], '2.79.5')
        expect(closed.changes[0]).toMatchObject({ state: 'closed', checkedInVersion: '2.79.5' })
        expect(reconcileAfterRollout(closed.records, [verified()], '2.79.6').changes).toEqual([])
    })

    it('records a refused delegation and retries it bounded, never by its own POST', async () => {
        const path = tmp()
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        const delegate = vi.fn(async () => ({ ok: false as const, reason: 'Zu viele offene Delegationen (max. 20).' }))
        const port = { config: { enabled: true, url: 'http://agentic.example.com' }, delegate, get: () => null }
        for (let i = 0; i < 7; i++) await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, delegation: port })
        expect(delegate).toHaveBeenCalledTimes(5)
        expect(fetchSpy).not.toHaveBeenCalled()
        fetchSpy.mockRestore()
    })
})
