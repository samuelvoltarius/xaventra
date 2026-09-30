import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    handoffMessage, reconcileAfterRollout, runClaudeHandoffTick, selectHandoffs, setClaudeHandoffConfig, validHandoffUrl, type HandoffRecord,
} from './claude-handoff.js'
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
        const message = handoffMessage(record)
        expect(message.to_agent).toBe('CLAUDE')
        expect(message.content).toContain('keine Anweisungen')
        expect(message.metadata).toMatchObject({ untrusted: true, caseId: 'case-1', version: '2.79.3' })
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

    it('accepts only plain http(s) delivery URLs', () => {
        expect(validHandoffUrl('http://100.86.70.71:3301/')).toBe('http://100.86.70.71:3301')
        expect(validHandoffUrl('http://user:pw@host:3301')).toBeNull()
        expect(validHandoffUrl('file:///etc/passwd')).toBeNull()
        expect(validHandoffUrl(undefined)).toBeNull()
    })

    it('keeps an outbox without network by default and delivers only when configured', async () => {
        const path = tmp()
        const post = vi.fn(async () => true)
        setClaudeHandoffConfig(undefined)
        const offline = await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, post })
        expect(offline).toEqual({ queued: 1, delivered: 0, reconciled: 0 })
        expect(post).not.toHaveBeenCalled()

        setClaudeHandoffConfig({ url: 'http://100.86.70.71:3301' })
        const online = await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, post })
        expect(online.delivered).toBe(1)
        expect(post).toHaveBeenCalledWith('http://100.86.70.71:3301/messages', expect.objectContaining({ to_agent: 'CLAUDE', thread_id: 'xaventra-doctor-case-1' }))
        // Same version, nothing new: no resend.
        expect((await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, post })).delivered).toBe(0)
        // Next release fixed it: one follow-up message.
        const after = await runClaudeHandoffTick({ cases: [verified({ findingOpen: false })], ...ctx, version: '2.79.4', path, post })
        expect(after).toMatchObject({ reconciled: 1, delivered: 1 })
        expect((post.mock.calls.at(-1) as any)[1].content).toContain('GESCHLOSSEN')
        setClaudeHandoffConfig(undefined)
    })

    it('does not mark a failed delivery as sent', async () => {
        const path = tmp()
        setClaudeHandoffConfig({ url: 'http://127.0.0.1:9' })
        const result = await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, post: async () => { throw new Error('ECONNREFUSED') } })
        expect(result.delivered).toBe(0)
        const retry = vi.fn(async () => true)
        expect((await runClaudeHandoffTick({ cases: [verified()], ...ctx, path, post: retry })).delivered).toBe(1)
        setClaudeHandoffConfig(undefined)
    })
})
