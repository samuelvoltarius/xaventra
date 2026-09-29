import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real lease verification (verifyLiveServiceLeadership) against a stubbed
// Supabase coordinator; only startup/watch plumbing is mocked.
const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../mesh/leader-election.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../mesh/leader-election.js')>()
    return {
        ...actual,
        // CL-07: the real acquisition adopts the fence that the read-only
        // live check (nova_check_fence) later confirms.
        watchForServiceLeadership: vi.fn(),
        onLeadershipLost: vi.fn(() => () => undefined),
        stopLeaseRenewal: vi.fn(),
    }
})
vi.mock('./ha-state.js', () => ({
    isHaStateAvailable: async () => false, hydrateChannelState: vi.fn(), publishChannelState: async () => true,
    readHaRecords: async () => [], writeHaRecord: async () => true,
}))
vi.mock('../channels/telegram.js', () => ({ createTelegramAdapter: mocks.create, connectL15NotifyCallback: vi.fn() }))
vi.mock('./runtime-readiness.js', () => ({ awaitRuntimeReady: async () => undefined }))
vi.mock('../channels/telegram-presentation.js', () => ({
    TelegramPresentationSession: class { async deliver() { return 'ok' } async clearProgress() {} },
}))
vi.mock('../tools/reminder-tool.js', () => ({ setReminderNotifyCallback: vi.fn(), setReminderWakeupCallback: vi.fn(), initReminders: vi.fn() }))
vi.mock('./heartbeat.js', () => ({ setHeartbeatNotifyCallback: vi.fn(), setHeartbeatWakeupCallback: vi.fn() }))
vi.mock('./runtime-event-log.js', () => ({ logRuntimeEvent: vi.fn() }))

const ENV_KEYS = ['NOVA_DISABLE_LEADER_ELECTION', 'NOVA_MAIN_ELIGIBLE', 'NOVA_MESH_SUPABASE_URL', 'NOVA_MESH_SUPABASE_KEY'] as const
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
    vi.resetModules()
    for (const key of ENV_KEYS) vi.stubEnv(key, undefined as unknown as string)
    vi.stubEnv('NOVA_NODE_ONLY', 'false')
    vi.stubEnv('NOVA_NO_TELEGRAM', 'false')
    vi.stubEnv('NOVA_TELEGRAM_MODE', 'primary')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('H12 Telegram inbound survives a coordinator 5xx', () => {
    it('keeps the acknowledged update queued during the outage and processes it after recovery', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-tg-authority-'))
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ supabase: { meshUrl: 'https://coord.test/rest/v1', meshKey: 'k' }, mesh: { mode: 'ha' } }))
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
        let outage = false
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (outage) return json({ message: 'upstream unavailable' }, 503)
            const expires = new Date(Date.now() + 90_000).toISOString()
            if (url.includes('/rpc/nova_check_fence')) return json({ valid: true, epoch: 2 })
            if (url.includes('/rpc/nova_acquire_service_lease')) return json({ leader: true, holder_node_id: getLocalNodeId(), epoch: 2, expires_at: expires })
            return json([{ holder_node_id: getLocalNodeId(), expires_at: expires, epoch: 2 }])
        }))

        let adapterConfig: any
        let onMessage: ((msg: any) => Promise<void>) | undefined
        mocks.create.mockImplementation((config: any) => {
            adapterConfig = config
            return {
                onMessage: (handler: any) => { onMessage = handler },
                connect: async () => undefined, disconnect: async () => undefined, getUsername: () => 'test-bot',
            }
        })
        const { startTelegram } = await import('./daemon-channels.js')
        const handler = vi.fn(async (_c: string, _f: string, _t: string, reply: (text: string) => Promise<void>) => { await reply('answer') })
        await startTelegram({ enabled: true, token: 'synthetic' }, handler as any, { channels: { telegram: null, whatsapp: null, discord: null } })
        expect(typeof adapterConfig.persistInbound).toBe('function')

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        outage = true
        // The adapter persists synchronously from the poll listener, then dispatches.
        adapterConfig.persistInbound({ id: 'tg-update:500', chatId: '100', from: '9', content: 'während Ausfall' })
        await onMessage!({ id: 'tg-update:500', from: '9', to: '100', content: 'während Ausfall' })
        expect(handler).not.toHaveBeenCalled()
        const queued = readFileSync(join(dir, '.nova-data', 'msg-queue.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(queued.find((m: any) => m.id === 'tg-update:500')).toMatchObject({ status: 'pending', content: 'während Ausfall' })

        outage = false
        await vi.advanceTimersByTimeAsync(20_000)
        expect(handler).toHaveBeenCalledTimes(1)
        const after = readFileSync(join(dir, '.nova-data', 'msg-queue.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(after.find((m: any) => m.id === 'tg-update:500')?.status).toBe('done')

        // A redelivery of the processed update is still a duplicate.
        await onMessage!({ id: 'tg-update:500', from: '9', to: '100', content: 'während Ausfall' })
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
