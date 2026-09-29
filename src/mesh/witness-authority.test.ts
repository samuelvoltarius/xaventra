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

describe('H13 witness mode never degrades to a local-only leader', () => {
    it('keeps nova-main witness-controlled even if it is not listed in coordination.services', async () => {
        useConfig({ mesh: { coordination: { mode: 'witness', authorityService: MAIN_SERVICE, services: ['telegram'], witnesses: [] } } })
        const decision = await acquireServiceLease(MAIN_SERVICE)
        expect(decision.leader).toBe(false)
        expect(decision.coordinator).toBe('witness')
    })

    it('refuses a local-only lease for a non-governed service while witness mode is configured', async () => {
        useConfig({ mesh: { coordination: { mode: 'witness', services: ['telegram'], witnesses: [] } } })
        const decision = await acquireServiceLease('h13-ungoverned')
        expect(decision.leader).toBe(false)
        expect(decision.coordinator).not.toBe('local')
    })

    it('treats an unreadable config as a possible witness request (fail-closed)', () => {
        useConfig('{ "mesh": { "coordination": { "mode": "witness", ')
        expect(witnessModeRequested()).toBe(true)
    })
})
