import { describe, expect, it, vi } from 'vitest'
import {
    FENCE_SUPPORT_MIN_VERSION, V5_RPCS, createPostgrestFencingProbe, evaluateFencingEnforceReadiness,
    reportFencingEnforceReadiness, type FencingFacts,
} from './fencing-readiness.js'
import type { Thought, ThoughtSink } from './thought-sink.js'

const nodes = [
    { nodeId: 'xaventra-spark', version: '2.80.0', status: 'online' as const },
    { nodeId: 'xaventra-ns1', version: '2.80.0', status: 'online' as const },
    { nodeId: 'xaventra-ns2', version: '2.79.4', status: 'busy' as const },
    { nodeId: 'xaventra-old', version: '2.70.0', status: 'offline' as const },
]
function goodFacts(): FencingFacts {
    return {
        appRole: 'xaventra_clean_app_20260908',
        rpcs: Object.fromEntries(V5_RPCS.map(name => [name, 'granted'])) as FencingFacts['rpcs'],
        coordinator: { version: 5, epoch_sequence: true, epoch_guard_trigger: true, lease_table_anon_writable: false, lease_write_policies: 0 },
        leaseProtocol: 'v2',
        currentEpochs: { 'nova-main': 226, telegram: 225 },
        nodes,
        highWater: { 'xaventra-spark': { 'nova-main': 226 }, 'xaventra-ns1': { 'nova-main': 220 }, 'xaventra-ns2': {} },
    }
}
class MemorySink implements ThoughtSink { thoughts: Thought[] = []; async emit(t: Thought) { this.thoughts.push(t) } }

describe('fencing enforce readiness (read-only report, never switches)', () => {
    it('reports safe only when every gate holds', () => {
        const r = evaluateFencingEnforceReadiness(goodFacts())
        expect(r.safe).toBe(true)
        expect(r.checks.every(c => c.ok)).toBe(true)
        expect(FENCE_SUPPORT_MIN_VERSION).toBe('2.79.0')
    })

    it('not safe when the real PostgREST app role lacks EXECUTE on a v5 RPC (403 incident 30.09.)', () => {
        const facts = goodFacts(); facts.rpcs.nova_acquire_service_lease_v2 = 'denied'
        const r = evaluateFencingEnforceReadiness(facts)
        expect(r.safe).toBe(false)
        const gate = r.checks.find(c => c.id === 'app-role-execute')!
        expect(gate.ok).toBe(false)
        expect(gate.evidence).toContain('xaventra_clean_app_20260908')
        expect(gate.evidence).toContain('nova_acquire_service_lease_v2')
    })

    it('not safe when v5 is missing, a node is too old, protocol is v1 or the lease table is writable', () => {
        const absent = goodFacts(); absent.rpcs.nova_check_fence = 'absent'; absent.coordinator = null
        expect(evaluateFencingEnforceReadiness(absent).checks.find(c => c.id === 'v5-rpcs-present')!.ok).toBe(false)
        const old = goodFacts(); old.nodes = [...nodes, { nodeId: 'xaventra-nas', version: '2.78.58', status: 'online' }]; old.highWater['xaventra-nas'] = {}
        const r = evaluateFencingEnforceReadiness(old)
        expect(r.safe).toBe(false)
        expect(r.checks.filter(c => !c.ok).map(c => c.id)).toEqual(['node-versions'])
        expect(r.checks.find(c => c.id === 'node-versions')!.evidence).toContain('xaventra-nas')
        const garbage = goodFacts(); garbage.nodes = [{ nodeId: 'x', version: 'unknown', status: 'online' }]; garbage.highWater = { x: {} }
        expect(evaluateFencingEnforceReadiness(garbage).checks.filter(c => !c.ok).map(c => c.id)).toEqual(['node-versions'])
        const v1 = goodFacts(); v1.leaseProtocol = 'v1'
        expect(evaluateFencingEnforceReadiness(v1).safe).toBe(false)
        const writable = goodFacts(); writable.coordinator!.lease_table_anon_writable = true
        expect(evaluateFencingEnforceReadiness(writable).safe).toBe(false)
    })

    it('not safe when a high-water mark is above the coordinator epoch or unknown', () => {
        const above = goodFacts(); above.highWater['xaventra-ns1'] = { 'nova-main': 300 }
        const r = evaluateFencingEnforceReadiness(above)
        expect(r.safe).toBe(false)
        expect(r.checks.find(c => c.id === 'highwater-consistent')!.evidence).toContain('xaventra-ns1')
        const unknown = goodFacts(); unknown.highWater['xaventra-ns2'] = null
        expect(evaluateFencingEnforceReadiness(unknown).safe).toBe(false)
        const missingNode = goodFacts(); delete missingNode.highWater['xaventra-ns2']
        expect(evaluateFencingEnforceReadiness(missingNode).safe).toBe(false)
    })

    it('PostgREST probe uses only GET: 403 on a read-only RPC and hidden OpenAPI paths mean "not granted"', async () => {
        const calls: Array<{ url: string; method: string }> = []
        const fetcher = vi.fn(async (input: any, init?: any) => {
            const url = String(input); calls.push({ url, method: String(init?.method || 'GET') })
            if (url === 'https://coord.example/') return Response.json({ paths: { '/rpc/nova_check_fence': {}, '/rpc/nova_fencing_status': {} } })
            if (url.startsWith('https://coord.example/rpc/nova_fencing_status')) return Response.json({ code: '42501', message: 'permission denied for function nova_fencing_status' }, { status: 403 })
            if (url.startsWith('https://coord.example/rpc/nova_check_fence')) return Response.json({ valid: false, epoch: 226 })
            return new Response('', { status: 404 })
        })
        const probe = createPostgrestFencingProbe({ url: 'https://coord.example', key: 'k', appRole: 'xaventra_clean_app_20260908', fetcher: fetcher as any })
        const facts = await probe.collect({ services: ['nova-main'] })
        expect(calls.every(c => c.method === 'GET')).toBe(true)
        expect(facts.rpcs).toMatchObject({ nova_fencing_status: 'denied', nova_acquire_service_lease_v2: 'denied', nova_fenced_upsert_shared_memory: 'denied', nova_check_fence: 'granted' })
        expect(facts.currentEpochs['nova-main']).toBe(226)
        const r = evaluateFencingEnforceReadiness({ ...goodFacts(), ...facts, nodes, highWater: goodFacts().highWater, leaseProtocol: 'v2' })
        expect(r.safe).toBe(false)
    })

    it('probe classifies 404 as absent and network failure as unknown', async () => {
        const fetcher = vi.fn(async (input: any) => String(input) === 'https://c/' ? Promise.reject(Error('ECONNREFUSED')) : new Response('', { status: 404 }))
        const facts = await createPostgrestFencingProbe({ url: 'https://c', key: 'k', appRole: 'r', fetcher: fetcher as any }).collect({ services: ['nova-main'] })
        expect(facts.rpcs.nova_fencing_status).toBe('absent')
        expect(facts.rpcs.nova_acquire_service_lease_v2).toBe('unknown')
        expect(facts.coordinator).toBeNull()
    })

    it('emits one result thought and never changes the fencing mode', async () => {
        const before = process.env.NOVA_FENCING_MODE
        const sink = new MemorySink(), facts = goodFacts(); facts.rpcs.nova_fencing_status = 'denied'
        const r = await reportFencingEnforceReadiness(facts, sink, Date.parse('2026-10-01T12:00:00Z'))
        expect(r.safe).toBe(false)
        expect(sink.thoughts).toHaveLength(1)
        expect(sink.thoughts[0]).toMatchObject({ kind: 'fencing-readiness', permission: 'selbst' })
        expect(sink.thoughts[0].proposal).toBeUndefined()
        expect(sink.thoughts[0].text).toContain('nicht sicher')
        expect(process.env.NOVA_FENCING_MODE).toBe(before)
        const ok = new MemorySink()
        await reportFencingEnforceReadiness(goodFacts(), ok)
        expect(ok.thoughts[0]).toMatchObject({ permission: 'fragen', proposal: { action: 'fencing.enforce.review' } })
        expect(ok.thoughts[0].text).toContain('sicher')
    })
})
