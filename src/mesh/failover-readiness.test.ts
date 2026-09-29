import { describe, expect, it } from 'vitest'
import { evaluateFailoverReadiness, formatFailoverReadiness } from './failover-readiness.js'

const now = Date.now()
// CL-07: HA readiness now also requires enforced fencing on a locked v5 coordinator.
const fencing = {
    mode: 'enforce' as const, protocol: 'v2' as const,
    status: { version: 5, epoch_sequence: true, epoch_guard_trigger: true, lease_table_anon_writable: false, lease_write_policies: 0 },
}
const node = (id: string) => ({ node_id: id, hostname: id, platform: 'linux', version: '1', tools_count: 1, status: 'online' as const, capabilities: [], last_heartbeat: new Date(now).toISOString(), registered_at: new Date(now).toISOString() })

describe('failover readiness', () => {
    it('requires a live shared authority, exactly-once channel lease and standby in HA mode', () => {
        const ready = evaluateFailoverReadiness({
            mode: 'ha', nodes: [node('spark'), node('pi')],
            authority: { nodeId: 'spark', services: ['nova-main', 'telegram'], epoch: 4, expiresAt: new Date(now + 60_000).toISOString() },
            standby: { nodeId: 'pi' }, haStateAvailable: true,
            mission: { status: 'active', checkpointAt: now, ownerNode: 'spark' }, fencing, now,
        })
        expect(ready.ready).toBe(true)
        expect(ready.estimatedRtoMs).toBeLessThan(120_000)
    })

    it('fails closed when Telegram and Main do not share the authority', () => {
        const report = evaluateFailoverReadiness({
            mode: 'ha', nodes: [node('spark'), node('pi')],
            authority: { nodeId: 'spark', services: ['nova-main'], epoch: 4, expiresAt: new Date(now + 60_000).toISOString() },
            standby: { nodeId: 'pi' }, haStateAvailable: true, now,
        })
        expect(report.ready).toBe(false)
        expect(report.gates.find(gate => gate.id === 'telegram-exactly-once')?.ok).toBe(false)
    })

    it('CL-07: is not ready while fencing only observes, runs on the v1 RPC or the lease table is writable', () => {
        const base = {
            mode: 'ha' as const, nodes: [node('spark'), node('pi')],
            authority: { nodeId: 'spark', services: ['nova-main', 'telegram'], epoch: 4, expiresAt: new Date(now + 60_000).toISOString() },
            standby: { nodeId: 'pi' }, haStateAvailable: true, now,
        }
        const gate = (report: ReturnType<typeof evaluateFailoverReadiness>, id: string) => report.gates.find(item => item.id === id)?.ok
        const observe = evaluateFailoverReadiness({ ...base, fencing: { ...fencing, mode: 'observe' } })
        expect(observe.ready).toBe(false)
        expect(gate(observe, 'fencing-enforced')).toBe(false)
        expect(gate(evaluateFailoverReadiness({ ...base, fencing: { ...fencing, protocol: 'v1' } }), 'fencing-enforced')).toBe(false)
        const writable = evaluateFailoverReadiness({ ...base, fencing: { ...fencing, status: { ...fencing.status, lease_table_anon_writable: true } } })
        expect(gate(writable, 'lease-table-locked')).toBe(false)
        const noStatus = evaluateFailoverReadiness({ ...base, fencing: { ...fencing, status: null } })
        expect(gate(noStatus, 'fencing-enforced')).toBe(false)
        expect(gate(noStatus, 'lease-table-locked')).toBe(false)
        // Standalone installations are not affected.
        expect(evaluateFailoverReadiness({ ...base, mode: 'standalone' }).ready).toBe(true)
        // /mesh failover shows the observe-period counters for the rollout decision.
        expect(formatFailoverReadiness(observe)).toMatch(/Fencing (observe|enforce): Verstöße \d+, blockiert \d+/)
    })
})
