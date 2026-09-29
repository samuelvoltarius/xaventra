import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptFence, resetFenceStateForTests } from '../mesh/fence.js'
import { hydrateChannelState, readHaRecords, writeHaRecord } from './ha-state.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const URL_BASE = 'https://coord.test/rest/v1'

function useConfig(): void {
    const dir = mkdtempSync(join(tmpdir(), 'nova-ha-fence-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ supabase: { meshUrl: URL_BASE, meshKey: 'k' }, mesh: { mode: 'ha' } }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

function holdMain(epoch: number): void {
    adoptFence({ service: 'nova-main', epoch, token: `nova-main:${epoch}:node-a`, coordinator: 'supabase', nodeId: 'node-a', instanceId: 'instance-a-123', deadlineMono: performance.now() + 60_000 })
}

beforeEach(() => {
    vi.stubEnv('NOVA_HA_STATE_KEY', 'x'.repeat(40))
    vi.stubEnv('NOVA_FENCING_MODE', 'observe')
    resetFenceStateForTests()
    useConfig()
})
afterEach(() => { resetFenceStateForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('CL-07 receiver-side fencing of Supabase HA writes', () => {
    it('writes HA records only through the fenced upsert RPC with epoch and instance', async () => {
        holdMain(77)
        const calls: Array<{ url: string; method: string; body: any }> = []
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
            return json({ written: true, reason: 'written', current_epoch: 77 })
        }))
        expect(await writeHaRecord('outcome-ledger', 'evt-1', { ok: true })).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(`${URL_BASE}/rpc/nova_fenced_upsert_shared_memory`)
        expect(calls[0].body).toMatchObject({ p_fence_service: 'nova-main', p_epoch: 77, p_holder_node_id: 'node-a', p_holder_instance_id: 'instance-a-123' })
        expect(calls[0].body.p_row).toMatchObject({ id: 'evt-1', scope: 'outcome-ledger' })
    })

    it('reports a write rejected by the database (stale fence or newer writer) as failed', async () => {
        holdMain(77)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.stubGlobal('fetch', vi.fn(async () => json({ written: false, reason: 'stale_fence', current_epoch: 78 })))
        expect(await writeHaRecord('ha-message-queue', 'q-1', { ok: true })).toBe(false)
        expect(warn.mock.calls.some(call => String(call[0]).includes('stale_fence'))).toBe(true)
    })

    it('without a fence: enforce refuses without touching Supabase, observe writes as before', async () => {
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method || 'GET') === 'GET' ? json([]) : json({}, 201))
        vi.stubGlobal('fetch', fetchMock)
        vi.stubEnv('NOVA_FENCING_MODE', 'enforce')
        expect(await writeHaRecord('outcome-ledger', 'evt-2', { ok: true })).toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
        vi.stubEnv('NOVA_FENCING_MODE', 'observe')
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        expect(await writeHaRecord('outcome-ledger', 'evt-2', { ok: true })).toBe(true)
        expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/rpc/'))).toBe(false)
    })

    it('falls back to the previous write path while v5 is not applied', async () => {
        holdMain(5)
        const urls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            urls.push(`${init?.method || 'GET'} ${url}`)
            if (url.includes('/rpc/')) return json({ message: 'not found' }, 404)
            return (init?.method || 'GET') === 'GET' ? json([]) : json({}, 201)
        }))
        expect(await writeHaRecord('codex-continuity', 'c-1', { ok: true })).toBe(true)
        expect(urls.some(item => item.startsWith('POST') && item.endsWith('/nova_shared_memory'))).toBe(true)
    })

    it('readers prefer the higher writer epoch over a newer writer timestamp', async () => {
        holdMain(9)
        const sealed: Record<string, string> = {}
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body))
            sealed[body.p_row.id + ':' + body.p_epoch] = body.p_row.content
            return json({ written: true })
        }))
        await writeHaRecord('ha-channel-state', 'old', { version: 1, channel: 'telegram', lastActiveChatId: 'stale-chat', adminChatId: null, lastActiveUserId: null, updatedAt: '' }, {}, 'nova-main')
        holdMain(10)
        await writeHaRecord('ha-channel-state', 'new', { version: 1, channel: 'telegram', lastActiveChatId: 'current-chat', adminChatId: null, lastActiveUserId: null, updatedAt: '' }, {}, 'nova-main')
        const meta = { format: 'nova-ha-state-v1', encrypted: true }
        vi.stubGlobal('fetch', vi.fn(async () => json([
            // The stale writer (epoch 9) has the later wall-clock timestamp.
            { id: 'old', user_id: 'system', role: 'system', content: sealed['old:9'], timestamp: 2_000, scope: 'ha-channel-state', metadata: meta, writer_epoch: 9 },
            { id: 'new', user_id: 'system', role: 'system', content: sealed['new:10'], timestamp: 1_000, scope: 'ha-channel-state', metadata: meta, writer_epoch: 10 },
        ])))
        const records = await readHaRecords<{ lastActiveChatId: string }>('ha-channel-state')
        expect(records.map(item => item.writerEpoch)).toEqual([10, 9])
        const state: Record<string, unknown> = {}
        const hydrated = await hydrateChannelState('telegram', state)
        expect(hydrated?.lastActiveChatId).toBe('current-chat')
    })
})
