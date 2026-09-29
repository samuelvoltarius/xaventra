import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }))
vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main', shouldStartExclusiveService: async () => true,
    verifyLiveServiceLeadership: mocks.verify, watchForServiceLeadership: vi.fn(),
    onLeadershipLost: vi.fn(() => () => undefined), stopLeaseRenewal: vi.fn(),
}))
vi.mock('./ha-state.js', () => ({
    isHaStateAvailable: async () => false, hydrateChannelState: vi.fn(), publishChannelState: async () => true,
    readHaRecords: async () => [], writeHaRecord: async () => true,
}))
vi.mock('../channels/telegram.js', () => ({ createTelegramAdapter: mocks.create, connectL15NotifyCallback: vi.fn() }))
vi.mock('./runtime-readiness.js', () => ({ awaitRuntimeReady: async () => undefined }))
vi.mock('./telegram-presentation.js', () => ({}))
vi.mock('../channels/telegram-presentation.js', () => ({
    TelegramPresentationSession: class { async deliver() { return 'ok' } async clearProgress() {} },
}))
vi.mock('../tools/reminder-tool.js', () => ({ setReminderNotifyCallback: vi.fn(), setReminderWakeupCallback: vi.fn(), initReminders: vi.fn() }))
vi.mock('./heartbeat.js', () => ({ setHeartbeatNotifyCallback: vi.fn(), setHeartbeatWakeupCallback: vi.fn() }))
vi.mock('./runtime-event-log.js', () => ({ logRuntimeEvent: vi.fn() }))

async function startHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'nova-tg-dedup-'))
    mkdirSync(join(dir, '.nova-data'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    let onMessage: ((msg: any) => Promise<void>) | undefined
    mocks.create.mockImplementation(() => ({
        onMessage: (handler: any) => { onMessage = handler },
        connect: async () => undefined, disconnect: async () => undefined, getUsername: () => 'test-bot',
    }))
    const { startTelegram } = await import('./daemon-channels.js')
    const handler = vi.fn(async (_channel: string, _from: string, _content: string, reply: (text: string) => Promise<void>) => { await reply('ok') })
    await startTelegram({ enabled: true, token: 'synthetic' }, handler as any, { channels: { telegram: null, whatsapp: null, discord: null } })
    return { handler, deliver: (msg: any) => onMessage!(msg) }
}

beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NOVA_NODE_ONLY', 'false')
    vi.stubEnv('NOVA_NO_TELEGRAM', 'false')
    vi.stubEnv('NOVA_TELEGRAM_MODE', 'primary')
    mocks.verify.mockResolvedValue(true)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('H10 daemon Telegram dedup', () => {
    it('does not treat equal message_ids from different chats as duplicates', async () => {
        const { handler, deliver } = await startHarness()
        await deliver({ id: '7', from: '9', to: '100', content: 'first chat' })
        await deliver({ id: '7', from: '9', to: '200', content: 'second chat' })
        expect(handler).toHaveBeenCalledTimes(2)
    })

    it('still drops a true redelivery of the same chat message', async () => {
        const { handler, deliver } = await startHarness()
        await deliver({ id: '7', from: '9', to: '100', content: 'once' })
        await deliver({ id: '7', from: '9', to: '100', content: 'once' })
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
