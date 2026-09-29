import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    acquireServiceLease,
    getLeaseProtocol,
    getLocalInstanceId,
    getServiceFencingToken,
    noteEventLoopGap,
    onLeadershipLost,
    shouldStartExclusiveService,
    stopLeaseRenewal,
    verifyLiveServiceLeadership,
} from './leader-election.js'
import { fenceSignal, getFenceStatus, resetFenceStateForTests } from './fence.js'
import { getLocalNodeId } from './mesh-registry.js'

const ENV_KEYS = ['NOVA_DISABLE_LEADER_ELECTION', 'NOVA_TELEGRAM_MODE', 'NOVA_NODE_ONLY', 'NOVA_MAIN_ELIGIBLE',
    'NOVA_MESH_SUPABASE_URL', 'NOVA_MESH_SUPABASE_KEY', 'NOVA_FENCING_MODE'] as const
const savedEnv: Record<string, string | undefined> = {}

function useConfig(config: unknown): void {
    const dir = mkdtempSync(join(tmpdir(), 'nova-fencing-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify(config))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

const SUPABASE = { supabase: { meshUrl: 'https://coord.test/rest/v1', meshKey: 'test-key' }, mesh: { mode: 'ha' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Coordinator { holder: string; instance: string | null; epoch: number; calls: string[]; v2: boolean }

function stubCoordinator(state: Coordinator): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method || 'GET'
        state.calls.push(`${method} ${url.replace('https://coord.test/rest/v1/', '')}`)
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const expires = new Date(Date.now() + 90_000).toISOString()
        if (url.includes('/rpc/nova_acquire_service_lease_v2')) {
            if (!state.v2) return json({ message: 'not found' }, 404)
            const mine = state.holder === body.p_holder_node_id && state.instance === body.p_holder_instance_id
            return json({ leader: mine, holder_node_id: state.holder, holder_instance_id: state.instance, epoch: state.epoch, expires_at: expires, server_now: new Date().toISOString() })
        }
        if (url.includes('/rpc/nova_acquire_service_lease')) {
            const mine = state.holder === body.p_holder_node_id
            return json({ leader: mine, holder_node_id: state.holder, epoch: state.epoch, expires_at: expires })
        }
        if (url.includes('/rpc/nova_check_fence')) {
            return json({ valid: state.holder === body.p_holder_node_id && state.epoch === body.p_epoch
                && (body.p_holder_instance_id === null || state.instance === body.p_holder_instance_id), epoch: state.epoch })
        }
        if (url.includes('nova_mesh_leases') && method === 'GET') {
            return json([{ holder_node_id: state.holder, holder_instance_id: state.instance, epoch: state.epoch, expires_at: expires }])
        }
        return json({ message: 'unexpected' }, 500)
    }))
}

beforeEach(() => {
    for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
    resetFenceStateForTests()
})
afterEach(() => {
    for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
    resetFenceStateForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('CL-07 lease hardening', () => {
    it('(c) verifyLiveServiceLeadership never acquires or renews a lease', async () => {
        useConfig(SUPABASE)
        const state: Coordinator = { holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 41, calls: [], v2: true }
        stubCoordinator(state)
        const service = 'fence-verify-readonly'
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            state.calls.length = 0
            expect(await verifyLiveServiceLeadership(service)).toBe(true)
            expect(state.calls).toEqual(['POST rpc/nova_check_fence'])
            // A node without the lease gets false without any coordinator write.
            state.calls.length = 0
            expect(await verifyLiveServiceLeadership('fence-not-held')).toBe(false)
            expect(state.calls).toEqual([])
            // After a takeover the check says no, and still writes nothing.
            state.holder = 'standby-node'; state.epoch = 42
            expect(await verifyLiveServiceLeadership(service)).toBe(false)
            expect(state.calls.every(call => call.includes('nova_check_fence'))).toBe(true)
        } finally { stopLeaseRenewal(service) }
    })

    it('does not cache a fencing token for an ad-hoc acquisition', async () => {
        useConfig(SUPABASE)
        stubCoordinator({ holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 7, calls: [], v2: true })
        const decision = await acquireServiceLease('fence-adhoc')
        expect(decision.leader).toBe(true)
        expect(decision.fencingToken).toBe(`fence-adhoc:7:${getLocalNodeId()}`)
        expect(getServiceFencingToken('fence-adhoc')).toBeNull()
    })

    it('always clears the cached fence on stop, even without a renewal timer', async () => {
        useConfig(SUPABASE)
        stubCoordinator({ holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 9, calls: [], v2: true })
        const service = 'fence-stop'
        expect(await shouldStartExclusiveService(service)).toBe(true)
        expect(getServiceFencingToken(service)?.epoch).toBe(9)
        stopLeaseRenewal(service)
        expect(getServiceFencingToken(service)).toBeNull()
        stopLeaseRenewal(service)
        expect(getServiceFencingToken(service)).toBeNull()
    })

    it('sends the process instance id and treats another instance on the same node as another holder', async () => {
        useConfig(SUPABASE)
        const state: Coordinator = { holder: getLocalNodeId(), instance: 'other-process-instance', epoch: 3, calls: [], v2: true }
        stubCoordinator(state)
        const decision = await acquireServiceLease('fence-instance')
        expect(decision.leader).toBe(false)
        expect(decision.heldByOther).toBe(true)
        expect(getLeaseProtocol()).toBe('v2')
    })

    it('falls back to the v1 RPC with a visible warning when the coordinator lacks v5', async () => {
        useConfig(SUPABASE)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        stubCoordinator({ holder: getLocalNodeId(), instance: null, epoch: 5, calls: [], v2: false })
        const decision = await acquireServiceLease('fence-v1')
        expect(decision.leader).toBe(true)
        expect(decision.protocol).toBe('v1')
        expect(getLeaseProtocol()).toBe('v1')
        expect(warn.mock.calls.some(call => String(call[0]).includes('v1 lease RPC'))).toBe(true)
    })

    it('never writes lease rows over REST when no lease RPC exists', async () => {
        useConfig(SUPABASE)
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push(`${init?.method || 'GET'} ${url}`)
            if (url.includes('/rpc/')) return json({ message: 'not found' }, 404)
            return json([])
        }))
        const decision = await acquireServiceLease('fence-no-rpc')
        expect(decision.leader).toBe(false)
        expect(calls.some(call => /^(POST|PATCH) .*nova_mesh_leases/.test(call))).toBe(false)
    })

    it('refuses NOVA_DISABLE_LEADER_ELECTION in mesh.mode=ha', async () => {
        useConfig(SUPABASE)
        process.env.NOVA_DISABLE_LEADER_ELECTION = 'true'
        const decision = await acquireServiceLease('fence-disabled-ha')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('refused')
    })

    it('expires the cached fence on the monotonic clock, independent of the wall clock', async () => {
        useConfig(SUPABASE)
        stubCoordinator({ holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 11, calls: [], v2: true })
        vi.useFakeTimers({ toFake: ['performance'] })
        const service = 'fence-mono'
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            vi.advanceTimersByTime(85_000)
            expect(getServiceFencingToken(service)?.epoch).toBe(11)
            vi.advanceTimersByTime(6_000)
            expect(getServiceFencingToken(service)).toBeNull()
        } finally { stopLeaseRenewal(service) }
    })

    it('fences synchronously and aborts in-flight work when the renewal reports another holder', async () => {
        useConfig(SUPABASE)
        process.env.NOVA_FENCING_MODE = 'enforce'
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
        const state: Coordinator = { holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 20, calls: [], v2: true }
        stubCoordinator(state)
        const service = 'fence-abort'
        let tokenSeenByLostHandler: unknown = 'unset'
        const off = onLeadershipLost(service, () => { tokenSeenByLostHandler = getServiceFencingToken(service) })
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            const signal = fenceSignal(service)
            expect(signal.aborted).toBe(false)
            state.holder = 'standby-node'; state.instance = 'standby-instance'; state.epoch = 21
            await vi.advanceTimersByTimeAsync(30_000)
            expect(signal.aborted).toBe(true)
            expect(tokenSeenByLostHandler).toBeNull()
            expect(getFenceStatus().held.some(item => item.service === service)).toBe(false)
        } finally { off(); stopLeaseRenewal(service) }
    })

    it('drops and releases mission sub-leases in the same step as nova-main', async () => {
        useConfig(SUPABASE)
        const state: Coordinator = { holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 60, calls: [], v2: true }
        stubCoordinator(state)
        expect(await shouldStartExclusiveService('nova-main')).toBe(true)
        expect(await shouldStartExclusiveService('mission:sub-1')).toBe(true)
        state.calls.length = 0
        stopLeaseRenewal('nova-main')
        expect(getServiceFencingToken('nova-main')).toBeNull()
        expect(getServiceFencingToken('mission:sub-1')).toBeNull()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(state.calls).toContain('POST rpc/nova_release_service_lease')
    })

    it('marks held fences suspect after an event-loop gap longer than TTL/2', async () => {
        useConfig(SUPABASE)
        stubCoordinator({ holder: getLocalNodeId(), instance: getLocalInstanceId(), epoch: 30, calls: [], v2: true })
        const service = 'fence-gap'
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            expect(noteEventLoopGap(10_000)).toEqual([])
            expect(noteEventLoopGap(50_000)).toContain(service)
            expect(getFenceStatus().held.find(item => item.service === service)?.suspect).toBe(true)
        } finally { stopLeaseRenewal(service) }
    })
})
