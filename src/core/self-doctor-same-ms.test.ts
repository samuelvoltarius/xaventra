import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// macOS CI 01.10.2026: two Doctor runs in the same millisecond. The NZ-33
// merge took the run's own previous save (updatedAt == runStartedAt) for a
// concurrent change and reopened findings the new run had just resolved.

const dir = mkdtempSync(join(tmpdir(), 'nova-self-doctor-same-ms-'))
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

describe('self-doctor runs within the same millisecond', () => {
    it('does not take its own previous save for a concurrent change and reopen resolved findings', async () => {
        const { runSelfDoctor } = await import('./self-doctor.js')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-01T02:43:25.000Z'))
        try {
            queue.stats = { total: 9, pending: 5, done: 3, failed: 1 }
            const first = await runSelfDoctor()
            expect(first.findings.filter(f => f.source === 'message-queue' && f.status === 'open').length).toBeGreaterThan(0)
            queue.stats = { total: 10, pending: 0, done: 10, failed: 0 }
            const second = await runSelfDoctor()
            expect(second.findings.filter(f => f.source === 'message-queue' && f.status === 'open')).toEqual([])
        } finally {
            vi.useRealTimers()
        }
    })

    it('still keeps a dismissal written during the run (NZ-33)', async () => {
        const { runSelfDoctor, updateDoctorFindingStatus } = await import('./self-doctor.js')
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-01T02:50:00.000Z'))
        try {
            queue.stats = { total: 9, pending: 5, done: 4, failed: 0 }
            const first = await runSelfDoctor()
            const backlog = first.findings.find(f => f.source === 'message-queue' && f.status === 'open')!
            expect(backlog).toBeTruthy()
            perf.onCall = () => { updateDoctorFindingStatus(backlog.id, 'dismissed'); perf.onCall = undefined }
            const second = await runSelfDoctor()
            expect(second.findings.find(f => f.id === backlog.id)).toBeUndefined()
            const { getDoctorFindings } = await import('./self-doctor.js')
            expect(getDoctorFindings().find(f => f.id === backlog.id)?.status).toBe('dismissed')
        } finally {
            perf.onCall = undefined
            vi.useRealTimers()
        }
    })
})
