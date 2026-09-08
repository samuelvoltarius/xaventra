import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    connect: vi.fn(), disconnect: vi.fn(), create: vi.fn(),
    lease: vi.fn(), verify: vi.fn(), watch: vi.fn(), lost: vi.fn(), stop: vi.fn(),
}))
vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main', shouldStartExclusiveService: mocks.lease,
    verifyLiveServiceLeadership: mocks.verify, watchForServiceLeadership: mocks.watch,
    onLeadershipLost: mocks.lost, stopLeaseRenewal: mocks.stop,
}))
vi.mock('./ha-state.js', () => ({ isHaStateAvailable: async () => false, hydrateChannelState: vi.fn() }))
vi.mock('../channels/telegram.js', () => ({ createTelegramAdapter: mocks.create, connectL15NotifyCallback: vi.fn() }))
vi.mock('../tools/reminder-tool.js', () => ({ setReminderNotifyCallback: vi.fn(), setReminderWakeupCallback: vi.fn(), initReminders: vi.fn() }))
vi.mock('./heartbeat.js', () => ({ setHeartbeatNotifyCallback: vi.fn(), setHeartbeatWakeupCallback: vi.fn() }))
vi.mock('./runtime-event-log.js', () => ({ logRuntimeEvent: vi.fn() }))

import { startTelegram } from './daemon-channels.js'

describe('actual Telegram starter concurrency', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        vi.stubEnv('NOVA_NODE_ONLY', 'false')
        vi.stubEnv('NOVA_NO_TELEGRAM', 'false')
        vi.stubEnv('NOVA_TELEGRAM_MODE', 'primary')
        mocks.lease.mockResolvedValue(true)
        mocks.verify.mockResolvedValue(true)
        mocks.connect.mockResolvedValue(undefined)
        mocks.disconnect.mockResolvedValue(undefined)
        mocks.create.mockImplementation(() => ({
            onMessage: vi.fn(), connect: mocks.connect, disconnect: mocks.disconnect,
            getUsername: () => 'isolated-test',
        }))
    })
    afterEach(() => vi.unstubAllEnvs())

    it('starts one poller for simultaneous Main/Telegram callbacks, then stays idempotent', async () => {
        const state = { channels: { telegram: null, whatsapp: null, discord: null } }
        const config = { enabled: true, token: 'synthetic-not-a-credential', allowFrom: [] }
        const handler = vi.fn()
        await Promise.all([startTelegram(config, handler, state), startTelegram(config, handler, state)])
        await startTelegram(config, handler, state)
        expect(mocks.create).toHaveBeenCalledTimes(1)
        expect(mocks.connect).toHaveBeenCalledTimes(1)
        expect(state.channels.telegram).not.toBeNull()
        expect(mocks.verify).toHaveBeenCalledWith('nova-main')
        expect(mocks.verify).toHaveBeenCalledWith('telegram')
    })

    it('disconnects a startup fenced while connecting', async () => {
        const state = { channels: { telegram: null, whatsapp: null, discord: null } }
        mocks.verify.mockResolvedValue(false)
        await startTelegram({ enabled: true, token: 'synthetic' }, vi.fn(), state)
        expect(mocks.disconnect).toHaveBeenCalledTimes(1)
        expect(state.channels.telegram).toBeNull()
        expect(mocks.stop).toHaveBeenCalledWith('telegram')
    })

    it('does not connect without Main authority', async () => {
        mocks.lease.mockResolvedValue(false)
        await startTelegram({ enabled: true, token: 'synthetic' }, vi.fn(), { channels: { telegram: null, whatsapp: null, discord: null } })
        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.watch).toHaveBeenCalledWith('nova-main', expect.any(Function))
    })

    it('retires once and ignores stale callbacks after a replacement starts', async () => {
        const state = { channels: { telegram: null, whatsapp: null, discord: null } }
        const config = { enabled: true, token: 'synthetic' }
        await startTelegram(config, vi.fn(), state)
        const callbacks = mocks.lost.mock.calls.map(call => call[1])
        await Promise.all(callbacks.map(callback => callback()))
        expect(mocks.disconnect).toHaveBeenCalledTimes(1)
        expect(state.channels.telegram).toBeNull()
        await startTelegram(config, vi.fn(), state)
        const replacement = state.channels.telegram
        await Promise.all(callbacks.map(callback => callback()))
        expect(state.channels.telegram).toBe(replacement)
        expect(mocks.stop).toHaveBeenCalledTimes(1)
    })
})
