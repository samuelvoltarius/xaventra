import { afterEach, describe, expect, it } from 'vitest'
import {
    acquireServiceLease,
    MAIN_BOUND_SERVICES,
    MAIN_SERVICE,
    noteLeaseCoordinatorHealthy,
    noteLeaseUnavailable,
    queueLeadershipTakeoverHandler,
    selectPreferredTakeoverNode,
    takeLeadershipTakeoverHandlers,
} from './leader-election.js'

describe('exclusive-service failover guard', () => {
    const oldDisable = process.env.NOVA_DISABLE_LEADER_ELECTION
    const oldMode = process.env.NOVA_TELEGRAM_MODE
    const oldNodeOnly = process.env.NOVA_NODE_ONLY
    const oldMainEligible = process.env.NOVA_MAIN_ELIGIBLE

    afterEach(() => {
        if (oldDisable === undefined) delete process.env.NOVA_DISABLE_LEADER_ELECTION
        else process.env.NOVA_DISABLE_LEADER_ELECTION = oldDisable
        if (oldMode === undefined) delete process.env.NOVA_TELEGRAM_MODE
        else process.env.NOVA_TELEGRAM_MODE = oldMode
        if (oldNodeOnly === undefined) delete process.env.NOVA_NODE_ONLY
        else process.env.NOVA_NODE_ONLY = oldNodeOnly
        if (oldMainEligible === undefined) delete process.env.NOVA_MAIN_ELIGIBLE
        else process.env.NOVA_MAIN_ELIGIBLE = oldMainEligible
    })

    it('never promotes a standby when distributed election is disabled', async () => {
        process.env.NOVA_DISABLE_LEADER_ELECTION = 'true'
        process.env.NOVA_TELEGRAM_MODE = 'standby'
        process.env.NOVA_NODE_ONLY = 'true'

        const decision = await acquireServiceLease('telegram')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('split-brain guard')
    })

    it('never lets a worker-only node acquire the canonical Main lease', async () => {
        process.env.NOVA_MAIN_ELIGIBLE = 'false'
        process.env.NOVA_DISABLE_LEADER_ELECTION = 'true'
        const decision = await acquireServiceLease(MAIN_SERVICE)
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('main-ineligible')
    })

    it('excludes stronger worker-only infrastructure from takeover preference', () => {
        const heartbeat = new Date().toISOString()
        const preferred = selectPreferredTakeoverNode([
            {
                node_id: 'nova-worker-a', hostname: 'ns1', platform: 'linux', version: 'test', tools_count: 100,
                status: 'online', capabilities: ['worker-only', 'main-ineligible'],
                hardware: { cores: 24, ram_gb: 125, disk_gb: 1800, disk_free_gb: 1100, cpu: 'server', arch: 'x64', os_name: 'linux', os_version: '' },
                last_heartbeat: heartbeat,
            },
            {
                node_id: 'nova-pi5', hostname: 'pi5', platform: 'linux', version: 'test', tools_count: 100,
                status: 'online', capabilities: ['main-eligible'],
                hardware: { cores: 4, ram_gb: 8, disk_gb: 117, disk_free_gb: 84, cpu: 'pi', arch: 'arm64', os_name: 'linux', os_version: '' },
                last_heartbeat: heartbeat,
            },
        ])
        expect(preferred?.nodeId).toBe('nova-pi5')
    })

    it('keeps every control-plane callback behind one takeover poller', () => {
        const service = 'test-main-multi-handler'
        const telegram = () => undefined
        const controlPlane = () => undefined
        queueLeadershipTakeoverHandler(service, telegram)
        queueLeadershipTakeoverHandler(service, controlPlane)
        expect(takeLeadershipTakeoverHandlers(service)).toEqual([telegram, controlPlane])
        expect(takeLeadershipTakeoverHandlers(service)).toEqual([])
    })

    it('defines the exclusive channel leases that move with planned Main handover', () => {
        expect(MAIN_BOUND_SERVICES).toEqual(['telegram', 'whatsapp', 'discord', 'dashboard'])
    })
})

describe('lease coordinator warning backoff', () => {
    it('logs an outage once, suppresses repeated checks, and logs again after the interval', () => {
        noteLeaseCoordinatorHealthy('test-warning')
        expect(noteLeaseUnavailable('test-warning', 503, 1_000, 10_000)).toEqual({ shouldLog: true, failures: 1 })
        expect(noteLeaseUnavailable('test-warning', 503, 2_000, 10_000)).toEqual({ shouldLog: false, failures: 2 })
        expect(noteLeaseUnavailable('test-warning', 503, 11_000, 10_000)).toEqual({ shouldLog: true, failures: 3 })
        expect(noteLeaseCoordinatorHealthy('test-warning')).toBe(3)
        expect(noteLeaseCoordinatorHealthy('test-warning')).toBe(0)
    })

    it('reports a changed coordinator status immediately', () => {
        noteLeaseCoordinatorHealthy('test-status')
        expect(noteLeaseUnavailable('test-status', 503, 1_000, 10_000).shouldLog).toBe(true)
        expect(noteLeaseUnavailable('test-status', 401, 2_000, 10_000).shouldLog).toBe(true)
        noteLeaseCoordinatorHealthy('test-status')
    })
})
