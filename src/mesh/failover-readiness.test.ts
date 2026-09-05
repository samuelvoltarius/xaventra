import { describe, expect, it } from 'vitest'
import { evaluateFailoverReadiness } from './failover-readiness.js'

const now = Date.now()
const node = (id: string) => ({ node_id: id, hostname: id, platform: 'linux', version: '1', tools_count: 1, status: 'online' as const, capabilities: [], last_heartbeat: new Date(now).toISOString(), registered_at: new Date(now).toISOString() })

describe('failover readiness', () => {
    it('requires a live shared authority, exactly-once channel lease and standby in HA mode', () => {
        const ready = evaluateFailoverReadiness({
            mode: 'ha', nodes: [node('spark'), node('pi')],
            authority: { nodeId: 'spark', services: ['nova-main', 'telegram'], epoch: 4, expiresAt: new Date(now + 60_000).toISOString() },
            standby: { nodeId: 'pi' }, haStateAvailable: true,
            mission: { status: 'active', checkpointAt: now, ownerNode: 'spark' }, now,
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
})
