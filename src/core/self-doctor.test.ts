import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #18: findings from message-queue, model-perf-db and self-update
// must be resolved once the (successfully evaluated) source no longer
// reproduces them; the failed-queue finding id must not contain the counter.

const dir = mkdtempSync(join(tmpdir(), 'nova-self-doctor-'))
vi.spyOn(process, 'cwd').mockReturnValue(dir)
delete process.env.NOVA_SUPABASE_URL
delete process.env.NOVA_MESH_SUPABASE_URL
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))

const queue = vi.hoisted(() => ({ stats: { total: 0, pending: 0, done: 0, failed: 0 } }))
const perf = vi.hoisted(() => ({ disabled: [] as any[], onCall: undefined as undefined | (() => void) }))
vi.mock('../config/config-path.js', () => ({ resolveConfigPath: () => join(process.cwd(), 'missing-config.json') }))
vi.mock('../channels/message-queue.js', () => ({ getQueueStats: () => queue.stats }))
vi.mock('../llm/model-perf-db.js', () => ({ getDisabledModels: () => { perf.onCall?.(); return perf.disabled } }))
vi.mock('./self-update.js', () => ({ getStats: () => ({ pending: 0 }), getPendingProposals: () => [] }))
vi.mock('../layers/L0-health-monitor.js', () => ({}))
vi.mock('../layers/L15-self-check.js', () => ({}))
vi.mock('../learning/trace-analyzer.js', () => ({}))
vi.mock('../llm/capability-probe.js', () => ({}))
vi.mock('../memory/memory-governance.js', () => ({}))
vi.mock('../memory/session-summarizer.js', () => ({}))
vi.mock('../mesh/capability-graph.js', () => ({}))
vi.mock('../mesh/failover-readiness.js', () => ({}))
vi.mock('../mesh/mesh-registry.js', () => ({}))
vi.mock('../doctor/failure-research-coordinator.js', () => ({}))

afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
})

describe('self-doctor resolves findings that are no longer reproduced (R2 NZ-18)', () => {
    it('closes a one-off message-queue backlog and a disabled-model finding', async () => {
        const { runSelfDoctor } = await import('./self-doctor.js')
        queue.stats = { total: 9, pending: 5, done: 3, failed: 1 }
        perf.disabled = [{ model: 'm1', reason: 'timeouts', disabledUntil: Date.now() + 60_000 }]
        const first = await runSelfDoctor()
        const openSources = first.findings.filter(f => f.status === 'open').map(f => f.source)
        expect(openSources).toContain('message-queue')
        expect(openSources).toContain('model-perf-db')

        // Counter changes must update the same finding, not open a second one.
        queue.stats = { total: 10, pending: 5, done: 3, failed: 2 }
        const second = await runSelfDoctor()
        expect(second.findings.filter(f => f.source === 'message-queue' && f.title.includes('permanently failed'))).toHaveLength(1)

        queue.stats = { total: 10, pending: 0, done: 10, failed: 0 }
        perf.disabled = []
        const third = await runSelfDoctor()
        const stillOpen = third.findings.filter(f => f.status === 'open' && ['message-queue', 'model-perf-db'].includes(f.source))
        expect(stillOpen).toEqual([])
        expect(fetchSpy).not.toHaveBeenCalled()
    })
})

describe('self-doctor summary and concurrent status changes (R2 NZ-33, NZ-34)', () => {
    it('shows the message queue inline without require() in ESM', async () => {
        const { runSelfDoctor } = await import('./self-doctor.js')
        queue.stats = { total: 4, pending: 0, done: 4, failed: 0 }
        const result = await runSelfDoctor()
        expect(result.summary).toContain('Message Queue')
    })

    it('keeps a dismissal made while a run was in progress', async () => {
        const { runSelfDoctor, updateDoctorFindingStatus } = await import('./self-doctor.js')
        queue.stats = { total: 9, pending: 5, done: 4, failed: 0 }
        const first = await runSelfDoctor()
        const backlog = first.findings.find(f => f.source === 'message-queue' && f.status === 'open')!
        expect(backlog).toBeTruthy()

        perf.onCall = () => { updateDoctorFindingStatus(backlog.id, 'dismissed') }
        const second = await runSelfDoctor()
        perf.onCall = undefined
        expect(second.findings.find(f => f.id === backlog.id)).toBeUndefined()
        const { getDoctorFindings } = await import('./self-doctor.js')
        expect(getDoctorFindings().find(f => f.id === backlog.id)?.status).toBe('dismissed')
    })
})
