import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
    localNodeId: 'node-a',
    nodes: [] as any[],
    released: [] as string[],
}))

vi.mock('./mesh-registry.js', () => ({
    getLocalNodeId: () => fixtures.localNodeId,
    discoverNodes: async () => fixtures.nodes,
}))
vi.mock('./witness-quorum.js', () => ({
    resolveWitnessAuthority: () => null,
    witnessModeRequested: () => false,
    acquireWitnessQuorumLease: async () => ({ leader: false, reason: 'unused' }),
    peekWitnessQuorum: async () => null,
}))

import { acquireServiceLease, MAIN_SERVICE, yieldMainToPreferredIfSafe } from './leader-election.js'
import { adoptFence, getFenceStatus, resetFenceStateForTests } from './fence.js'

const hold = (service: string, epoch = 1) => adoptFence({
    service, epoch, token: `${service}:${epoch}:node-a`, coordinator: 'supabase',
    nodeId: fixtures.localNodeId, instanceId: 'instance-a', deadlineMono: performance.now() + 60_000,
})

const heartbeat = (ageMs = 0) => new Date(Date.now() - ageMs).toISOString()

const node = (id: string, hardware: Record<string, number | string>, ageMs = 500) => ({
    node_id: id, hostname: id, platform: 'linux', version: 'test', tools_count: 10,
    status: 'online', capabilities: ['main-eligible'],
    hardware: { cores: 8, ram_gb: 32, disk_gb: 500, disk_free_gb: 400, cpu: 'x', arch: 'x64', os_name: 'linux', os_version: '', ...hardware },
    last_heartbeat: heartbeat(ageMs),
})

/**
 * 2.89.6 hand-back: when the stronger Main returns, the standby-Main yields the
 * channel leases first and nova-main last, and only while no update, mission or
 * outcome run is in flight. A weaker node never takes the lease from a stronger
 * one. No network: the coordinator and the mesh list are local stubs.
 */
describe('planned Main hand-back to the stronger node (2.89.6)', () => {
    let originalFetch: typeof globalThis.fetch
    let originalUrl: string | undefined
    let originalKey: string | undefined

    beforeEach(() => {
        fixtures.localNodeId = 'node-a'
        fixtures.nodes = []
        fixtures.released.length = 0
        resetFenceStateForTests()
        originalFetch = globalThis.fetch
        originalUrl = process.env.NOVA_MESH_SUPABASE_URL
        originalKey = process.env.NOVA_MESH_SUPABASE_KEY
        process.env.NOVA_MESH_SUPABASE_URL = 'https://mesh.example.com'
        process.env.NOVA_MESH_SUPABASE_KEY = 'fixture-mesh-key'
        globalThis.fetch = (async (_input: any, init?: any) => {
            const body = JSON.parse(String(init?.body || '{}'))
            if (body?.p_service) fixtures.released.push(String(body.p_service))
            return {
                ok: true, status: 200,
                json: async () => ({ released: true, reason: 'lease released for planned handover' }),
            }
        }) as any
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        if (originalUrl === undefined) delete process.env.NOVA_MESH_SUPABASE_URL
        else process.env.NOVA_MESH_SUPABASE_URL = originalUrl
        if (originalKey === undefined) delete process.env.NOVA_MESH_SUPABASE_KEY
        else process.env.NOVA_MESH_SUPABASE_KEY = originalKey
        resetFenceStateForTests()
    })

    /** The local standby holds the lease; a stronger Main comes back fresh. */
    const returnedStrongerMain = () => {
        fixtures.nodes = [
            node('node-a', { cores: 4, ram_gb: 8 }),
            node('node-b', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }, 1_000),
        ]
    }

    it('is not Main at all when no nova-main fence is held', async () => {
        const decision = await yieldMainToPreferredIfSafe(() => true)
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('not Main')
        expect(fixtures.released).toEqual([])
    })

    it('keeps the lease while an update, mission or outcome run is active', async () => {
        hold(MAIN_SERVICE, 3)
        hold('telegram', 3)
        returnedStrongerMain()
        const decision = await yieldMainToPreferredIfSafe(() => false)
        expect(decision.leader).toBe(true)
        expect(decision.reason).toMatch(/deferred by critical work/)
        expect(fixtures.released).toEqual([])
        expect(getFenceStatus().held.map(item => item.service)).toEqual(expect.arrayContaining(['nova-main', 'telegram']))
    })

    it('yields the channel leases first and nova-main last when the work is safe', async () => {
        hold('nova-main', 3)
        hold('telegram', 3)
        hold('dashboard', 3)
        returnedStrongerMain()
        const decision = await yieldMainToPreferredIfSafe(() => true)
        expect(decision.leader).toBe(false)
        expect(fixtures.released).toEqual(['telegram', 'dashboard', 'nova-main'])
        // Channels move before the Main so the successor can reconnect at once.
        expect(fixtures.released.indexOf('telegram')).toBeLessThan(fixtures.released.indexOf('nova-main'))
        expect(fixtures.released.indexOf('dashboard')).toBeLessThan(fixtures.released.indexOf('nova-main'))
        expect(getFenceStatus().held).toEqual([])
    })

    it('skips channel leases it never held and still hands the Main over', async () => {
        hold('nova-main', 2)
        returnedStrongerMain()
        const decision = await yieldMainToPreferredIfSafe(() => true)
        expect(decision.leader).toBe(false)
        expect(fixtures.released).toEqual(['nova-main'])
    })

    it('keeps the lease when this node is still the strongest healthy candidate', async () => {
        hold('nova-main', 4)
        fixtures.nodes = [
            node('node-a', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }),
            node('node-weak', { cores: 1, ram_gb: 1 }),
        ]
        const decision = await yieldMainToPreferredIfSafe(() => true)
        expect(decision.leader).toBe(true)
        expect(decision.reason).toContain('already the strongest')
        expect(fixtures.released).toEqual([])
    })

    it('keeps the lease when the only other node is stale or offline', async () => {
        hold('nova-main', 5)
        fixtures.nodes = [
            node('node-a', { cores: 4, ram_gb: 8 }),
            node('node-stale', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }, 90_000),
            { ...node('node-off', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }), status: 'offline' },
        ]
        const decision = await yieldMainToPreferredIfSafe(() => true)
        expect(decision.leader).toBe(true)
        expect(decision.reason).toContain('already the strongest')
        expect(fixtures.released).toEqual([])
    })
})

/**
 * The other half of the hand-back: after the standby yields, only the stronger
 * fresh candidate may take the vacant lease. A weaker one waits.
 */
describe('takeover priority after the hand-back (2.89.6)', () => {
    let originalFetch: typeof globalThis.fetch
    let originalUrl: string | undefined
    let originalKey: string | undefined

    beforeEach(() => {
        fixtures.localNodeId = 'node-a'
        fixtures.released.length = 0
        resetFenceStateForTests()
        originalFetch = globalThis.fetch
        originalUrl = process.env.NOVA_MESH_SUPABASE_URL
        originalKey = process.env.NOVA_MESH_SUPABASE_KEY
        process.env.NOVA_MESH_SUPABASE_URL = 'https://mesh.example.com'
        process.env.NOVA_MESH_SUPABASE_KEY = 'fixture-mesh-key'
        // Lease row: expired and held by another node (the Main that just died).
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = String(input)
            if (url.includes('rpc/')) {
                const body = JSON.parse(String(init?.body || '{}'))
                if (body?.p_service) fixtures.released.push(String(body.p_service))
                return {
                    ok: true, status: 200,
                    json: async () => ({ leader: true, epoch: 7, expires_at: new Date(Date.now() + 90_000).toISOString(), reason: 'transactional lease acquired' }),
                }
            }
            return {
                ok: true, status: 200,
                json: async () => [{
                    holder_node_id: 'node-b', holder_instance_id: 'instance-b',
                    expires_at: new Date(Date.now() - 1_000).toISOString(), epoch: 6,
                }],
            }
        }) as any
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        if (originalUrl === undefined) delete process.env.NOVA_MESH_SUPABASE_URL
        else process.env.NOVA_MESH_SUPABASE_URL = originalUrl
        if (originalKey === undefined) delete process.env.NOVA_MESH_SUPABASE_KEY
        else process.env.NOVA_MESH_SUPABASE_KEY = originalKey
        fixtures.nodes = []
        resetFenceStateForTests()
    })

    it('refuses the vacant Main lease to a weaker node while a stronger one is up', async () => {
        fixtures.nodes = [
            node('node-a', { cores: 2, ram_gb: 4 }),
            node('node-b', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }),
        ]
        const decision = await acquireServiceLease('nova-main')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toContain('stronger standby has takeover priority')
        expect(fixtures.released).toEqual([])
    })

    it('lets the stronger returned Main take the vacant lease', async () => {
        fixtures.localNodeId = 'node-b'
        fixtures.nodes = [
            node('node-a', { cores: 2, ram_gb: 4 }),
            node('node-b', { cores: 24, ram_gb: 128, gpu_vram_mb: 24_576 }),
        ]
        const decision = await acquireServiceLease('nova-main')
        expect(decision.leader).toBe(true)
        expect(fixtures.released).toEqual(['nova-main'])
    })
})

describe('the daemon defers the hand-back while critical work runs (2.89.6)', () => {
    const daemon = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
    const block = daemon.slice(daemon.indexOf('const preferStrongestMain ='), daemon.indexOf('Leistungsbasierter Main-Handover'))

    it('honours mesh.preferStrongestMain and NOVA_PREFER_STRONGEST_MAIN', () => {
        expect(block).toContain('mesh?.preferStrongestMain === true')
        expect(block).toContain('NOVA_PREFER_STRONGEST_MAIN')
    })

    it('defers the hand-back during an update, a mission and a running outcome', () => {
        expect(block).toContain('getUpdateStatus().running')
        expect(block).toContain("['planning', 'active'].includes(mission.status)")
        expect(block).toContain("run.status === 'running'")
        // Every one of the three returns false from the safety predicate.
        expect(block).toMatch(/if \(getUpdateStatus\(\)\.running\) return false/)
    })

    it('re-evaluates on a timer instead of handing over once at startup', () => {
        expect(block).toMatch(/setInterval\(\(\) => \{ void evaluatePlannedHandover/)
    })
})
