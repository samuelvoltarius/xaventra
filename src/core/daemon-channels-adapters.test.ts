import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
    discordConfig: null as any,
    whatsappHandler: null as null | ((msg: any) => Promise<void>),
    whatsappSend: vi.fn(async (_msg: any) => { }),
    dashboardHandler: null as null | ((message: string, channel: string) => Promise<string>),
    lease: vi.fn(async () => true),
    watch: vi.fn((_service: string, _onLeadership: () => Promise<void>) => { }),
    lost: vi.fn((_service: string, _handler: () => Promise<void> | void) => () => { }),
    dashboardStarts: vi.fn(async () => 'http://127.0.0.1:3011'),
    dashboardStops: vi.fn(async () => { }),
}))

vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main',
    shouldStartExclusiveService: captured.lease,
    watchForServiceLeadership: captured.watch,
    onLeadershipLost: captured.lost,
}))
vi.mock('../channels/discord.js', () => ({
    DiscordAdapter: class {
        constructor(config: any) { captured.discordConfig = config }
        onMessage() { }
        async connect() { }
    },
}))
vi.mock('../channels/whatsapp.js', () => ({
    WhatsAppAdapter: class {
        onMessage(handler: any) { captured.whatsappHandler = handler }
        async connect() { }
        send = captured.whatsappSend
    },
}))
vi.mock('../dashboard/server.js', () => ({
    startDashboard: captured.dashboardStarts,
    setNovaMessageHandler: (handler: any) => { captured.dashboardHandler = handler },
    stopDashboard: captured.dashboardStops,
}))
import { startDashboard, startDiscord, startWhatsApp } from './daemon-channels.js'

const state = () => ({ channels: { telegram: null, whatsapp: null, discord: null } }) as any

describe('channel starters match the hardened adapters', () => {
    it('passes allowFrom and guildId to the fail-closed Discord adapter (R2 UEB-1)', async () => {
        await startDiscord({ enabled: true, token: 't', allowFrom: ['123'], guildId: '456' }, vi.fn(async () => { }) as any, state())
        expect(captured.discordConfig).toMatchObject({ token: 't', allowFrom: ['123'], guildId: '456' })
    })

    it('answers a WhatsApp group message in the group, not privately (R2 UEB-2)', async () => {
        const handler = vi.fn(async (_channel: string, _from: string, _content: string, reply: (text: string) => Promise<void>) => { await reply('Antwort') })
        await startWhatsApp({ enabled: true }, handler as any, state())
        await captured.whatsappHandler!({ from: '4366012345@s.whatsapp.net', groupId: '1203630@g.us', content: '@nova hallo', isGroup: true })
        expect(captured.whatsappSend).toHaveBeenCalledWith(expect.objectContaining({ to: '1203630@g.us' }))
    })

    it('returns every partial dashboard reply, not only the last (R2 UEB-3)', async () => {
        const handler = vi.fn(async (_channel: string, _from: string, _content: string, reply: (text: string) => Promise<void>) => {
            await reply('Teil eins')
            await reply('Teil zwei')
        })
        await startDashboard({ enabled: true, port: 3011 }, handler as any, state())
        const response = await captured.dashboardHandler!('hallo', 'dashboard')
        expect(response).toContain('Teil eins')
        expect(response).toContain('Teil zwei')
    })
})

describe('the Dashboard follows the nova-main lease (2.89.6)', () => {
    const reset = () => {
        captured.lease.mockReset()
        captured.watch.mockClear()
        captured.lost.mockClear()
        captured.dashboardStarts.mockClear()
        captured.dashboardStops.mockClear()
    }

    it('serves nothing without the lease and starts only on takeover', async () => {
        reset()
        captured.lease.mockResolvedValue(false)
        await startDashboard({ enabled: true, port: 3011 }, vi.fn() as any, state())
        expect(captured.dashboardStarts).not.toHaveBeenCalled()
        const watched = captured.watch.mock.calls.map(call => call[0])
        expect(watched).toContain('nova-main')
        // Takeover: the queued handler runs once the lease is acquired.
        captured.lease.mockResolvedValue(true)
        await captured.watch.mock.calls.find(call => call[0] === 'nova-main')![1]()
        expect(captured.dashboardStarts).toHaveBeenCalledTimes(1)
    })

    it('stops on Main-lease loss and again on dashboard-lease loss', async () => {
        reset()
        captured.lease.mockResolvedValue(true)
        await startDashboard({ enabled: true, port: 3011 }, vi.fn() as any, state())
        expect(captured.dashboardStarts).toHaveBeenCalledTimes(1)
        const lostServices = captured.lost.mock.calls.map(call => call[0])
        expect(lostServices).toEqual(expect.arrayContaining(['dashboard', 'nova-main']))
        for (const call of captured.lost.mock.calls) await call[1]!()
        expect(captured.dashboardStops).toHaveBeenCalledTimes(2)
    })
})
