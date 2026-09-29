import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    acquireServiceLease,
    MAIN_SERVICE,
    onLeadershipLost,
    shouldStartExclusiveService,
    stopLeaseRenewal,
} from './leader-election.js'
import { witnessModeRequested } from './witness-quorum.js'
import { getLocalNodeId } from './mesh-registry.js'

const ENV_KEYS = ['NOVA_DISABLE_LEADER_ELECTION', 'NOVA_TELEGRAM_MODE', 'NOVA_NODE_ONLY', 'NOVA_MAIN_ELIGIBLE', 'NOVA_MESH_SUPABASE_URL', 'NOVA_MESH_SUPABASE_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}

function useConfig(config: unknown | string): string {
    const dir = mkdtempSync(join(tmpdir(), 'nova-leader-'))
    writeFileSync(join(dir, 'xaventra.config.json'), typeof config === 'string' ? config : JSON.stringify(config))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    return dir
}

const SUPABASE = { supabase: { meshUrl: 'https://coord.test/rest/v1', meshKey: 'test-key' }, mesh: { mode: 'ha' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
    for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
})
afterEach(() => {
    for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('lease renewal and REST fallback safety', () => {
    it('relinquishes immediately when the renewal answer says another node holds the lease', async () => {
        useConfig(SUPABASE)
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
        const service = 'renew-held-by-other'
        let holder = getLocalNodeId()
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.includes('/rpc/nova_acquire_service_lease')) {
                return holder === getLocalNodeId()
                    ? json({ leader: true, holder_node_id: holder, epoch: 3, expires_at: new Date(Date.now() + 90_000).toISOString() })
                    : json({ leader: false, holder_node_id: holder, epoch: 4, expires_at: new Date(Date.now() + 90_000).toISOString() })
            }
            return json([{ holder_node_id: holder, expires_at: new Date(Date.now() + 90_000).toISOString(), epoch: 3 }])
        }))
        const lost = vi.fn()
        const off = onLeadershipLost(service, lost)
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            holder = 'some-other-node'
            await vi.advanceTimersByTimeAsync(30_000)
            expect(lost).toHaveBeenCalledTimes(1)
        } finally { off(); stopLeaseRenewal(service) }
    })

    it('drops leadership at the hard deadline even if the renewal tick never completes', async () => {
        useConfig(SUPABASE)
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
        const service = 'renew-deadline'
        let hang = false
        vi.stubGlobal('fetch', vi.fn((url: string) => {
            if (hang) return new Promise<Response>(() => undefined)
            if (url.includes('/rpc/')) return Promise.resolve(json({ leader: true, holder_node_id: getLocalNodeId(), epoch: 1, expires_at: new Date(Date.now() + 90_000).toISOString() }))
            return Promise.resolve(json([{ holder_node_id: getLocalNodeId(), expires_at: new Date(Date.now() + 90_000).toISOString(), epoch: 1 }]))
        }))
        const lost = vi.fn()
        const off = onLeadershipLost(service, lost)
        try {
            expect(await shouldStartExclusiveService(service)).toBe(true)
            hang = true
            await vi.advanceTimersByTimeAsync(75_000)
            expect(lost).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(10_000)
            expect(lost).toHaveBeenCalledTimes(1)
        } finally { off(); stopLeaseRenewal(service) }
    })

    it('does not take over an expired foreign lease through the client-clock REST fallback', async () => {
        useConfig(SUPABASE)
        const methods: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            methods.push(`${init?.method || 'GET'} ${url}`)
            if (url.includes('/rpc/nova_acquire_service_lease')) return json({ message: 'not found' }, 404)
            if (url.includes('nova_mesh_leases') && (init?.method || 'GET') === 'GET') {
                return json([{ holder_node_id: 'dead-node', expires_at: new Date(Date.now() - 60_000).toISOString(), epoch: 7 }])
            }
            if (init?.method === 'PATCH') return json([{ service: 'x' }])
            return json([], 404)
        }))
        const decision = await acquireServiceLease('rest-takeover')
        expect(decision.leader).toBe(false)
        expect(methods.some(item => item.startsWith('PATCH'))).toBe(false)
    })
})
