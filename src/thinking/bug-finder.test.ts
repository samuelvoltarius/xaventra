import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { reconcileAfterRollout, selectHandoffs } from '../doctor/claude-handoff.js'
import { groupRecurring, runBugFinder, tracesErrorSource, type ErrorOccurrence } from './bug-finder.js'
import { MemoryThoughtSink, parseThinkingSettings } from './ports.js'

const NOW = new Date('2026-10-01T03:00:00Z')
const settings = (patch: Record<string, unknown> = {}) => parseThinkingSettings({ enabled: true, bugFinder: { enabled: true, minOccurrences: 5, ...patch } })
const occ = (i: number, message = `web_search timeout after ${4000 + i * 13} ms (request ${i})`): ErrorOccurrence => ({
    source: 'trace', subject: 'web_search', message, at: NOW.getTime() - i * 60_000, ref: `trace:2026-10-01:${i}`,
})
const coordinator = () => new FailureResearchCoordinator(join(mkdtempSync(join(process.cwd(), 'bug-')), 'failure-research.json'))

describe('Phase 3 Bug-Finder', () => {
    it('groups by the Stufe-1 fingerprint: changing numbers are the same fault', () => {
        const groups = groupRecurring([0, 1, 2, 3, 4, 5].map(i => occ(i)), 5)
        expect(groups).toHaveLength(1)
        expect(groups[0].count).toBe(6)
        expect(groups[0].refs).toHaveLength(6)
    })

    it('a recurring fault (>= N with evidence) becomes exactly one Doctor case, never a duplicate', async () => {
        const doctor = coordinator()
        const sink = new MemoryThoughtSink()
        const source = { collect: async () => [0, 1, 2, 3, 4].map(i => occ(i)) }
        const first = await runBugFinder({ settings: settings(), source, doctor, sink, now: NOW })
        expect(first.created).toHaveLength(1)
        expect(doctor.list()).toHaveLength(1)
        const [item] = doctor.list()
        expect(item.evidenceRefs.some(ref => ref.startsWith('trace:'))).toBe(true)
        expect(item.title).toMatch(/web_search/)
        expect(sink.thoughts).toHaveLength(1)
        expect(sink.thoughts[0]).toMatchObject({ source: 'bug-finder', stufe: 'selbst' })

        const more = { collect: async () => [0, 1, 2, 3, 4, 5, 6, 7].map(i => occ(i + 20)) }
        const second = await runBugFinder({ settings: settings(), source: more, doctor, sink, now: new Date(NOW.getTime() + 3600_000) })
        expect(second.created).toHaveLength(0)
        expect(second.skipped[0].reason).toMatch(/schon/)
        expect(doctor.list()).toHaveLength(1)
        expect(sink.thoughts).toHaveLength(1)

        // Also across a restart (new coordinator instance on the same file).
        const reloaded = new FailureResearchCoordinator((doctor as any).path)
        const third = await runBugFinder({ settings: settings(), source: more, doctor: reloaded, sink, now: new Date(NOW.getTime() + 7200_000) })
        expect(third.created).toHaveLength(0)
        expect(reloaded.list()).toHaveLength(1)
    })

    it('no second case when the Self-Doctor (L15) already has an open case for the same tool', async () => {
        const doctor = coordinator()
        doctor.ingest({ id: 'l15-web_search', title: 'Tool web_search is broken', detail: '5 consecutive failures, 0 empty results', category: 'tools', severity: 'critical',
            source: 'L15-self-check', recommendation: '', evidence: {}, status: 'open', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
        const result = await runBugFinder({ settings: settings(), source: { collect: async () => [0, 1, 2, 3, 4].map(i => occ(i)) }, doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(result.created).toHaveLength(0)
        expect(result.skipped[0].reason).toMatch(/Self-Doctor/)
        expect(doctor.list()).toHaveLength(1)
    })

    it('below N nothing happens', async () => {
        const doctor = coordinator()
        const result = await runBugFinder({ settings: settings(), source: { collect: async () => [0, 1, 2, 3].map(i => occ(i)) }, doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(result.created).toHaveLength(0)
        expect(doctor.list()).toHaveLength(0)
    })

    it('verified cases flow into the existing Claude handoff and the existing after-rollout check', async () => {
        const doctor = coordinator()
        await runBugFinder({ settings: settings(), source: { collect: async () => [0, 1, 2, 3, 4].map(i => occ(i)) }, doctor, sink: new MemoryThoughtSink(), now: NOW })
        const [item] = doctor.list()
        const verified = { ...item, investigation: { status: 'verified' as const, runId: 'r1', attempts: 1, nextAttemptAt: 0, report: 'belegt' } }
        const handoffs = selectHandoffs([verified], [], { node: 'spark', version: '2.83.0', now: NOW })
        expect(handoffs).toHaveLength(1)
        expect(handoffs[0].caseId).toBe(item.id)
        const after = reconcileAfterRollout([{ ...handoffs[0], state: 'sent' }], [{ ...verified, findingOpen: false }], '2.83.1')
        expect(after.changes[0].state).toBe('closed')
    })

    it('keeps secrets out of the Doctor case', async () => {
        const doctor = coordinator()
        const secret = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456 rejected'
        await runBugFinder({ settings: settings(), source: { collect: async () => [0, 1, 2, 3, 4].map(i => occ(i, secret)) }, doctor, sink: new MemoryThoughtSink(), now: NOW })
        expect(JSON.stringify(doctor.list())).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    })

    it('reads tool errors from trace files', async () => {
        const dir = mkdtempSync(join(process.cwd(), 'traces-'))
        mkdirSync(dir, { recursive: true })
        const line = (i: number) => JSON.stringify({ id: `t${i}`, timestamp: NOW.getTime() - i * 1000, success: false, errorType: 'tool_error',
            toolCalls: [{ name: 'ha_state', argsHash: 'x', latencyMs: 5, success: false, errorMessage: `ECONNREFUSED 10.0.0.${i}:8123`, resultSize: 0 }] })
        writeFileSync(join(dir, '2026-10-01.jsonl'), [0, 1, 2, 3, 4, 5].map(line).join('\n') + '\n')
        const found = await tracesErrorSource(dir).collect(NOW.getTime() - 86_400_000)
        expect(found.filter(item => item.subject === 'ha_state')).toHaveLength(6)
        expect(groupRecurring(found, 5).map(group => group.subject)).toContain('ha_state')
    })
})
