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

describe('coordinator config must be readable and explicit', () => {
    it('yields leader:false when the config cannot be parsed, even with coordinator env credentials', async () => {
        useConfig('{ not json')
        process.env.NOVA_MESH_SUPABASE_URL = 'https://coord.test/rest/v1'
        process.env.NOVA_MESH_SUPABASE_KEY = 'test-key'
        const fetchMock = vi.fn(async () => json([]))
        vi.stubGlobal('fetch', fetchMock)
        const decision = await acquireServiceLease('cfg-unreadable')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toMatch(/unreadable/)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not become local leader when no coordinator is configured and single-node is not declared', async () => {
        useConfig({ name: 'nova' })
        const decision = await acquireServiceLease('cfg-implicit')
        expect(decision.leader).toBe(false)
        expect(decision.reason).toMatch(/single-node/)
    })

    it('becomes local-only leader only when the config explicitly declares single-node', async () => {
        useConfig({ mesh: { mode: 'standalone' } })
        const decision = await acquireServiceLease('cfg-standalone')
        expect(decision).toMatchObject({ leader: true, coordinator: 'local' })
    })
})
