import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
    discordConfig: null as any,
    whatsappHandler: null as null | ((msg: any) => Promise<void>),
    whatsappSend: vi.fn(async (_msg: any) => { }),
    dashboardHandler: null as null | ((message: string, channel: string) => Promise<string>),
}))

vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main',
    shouldStartExclusiveService: async () => true,
    watchForServiceLeadership: () => { },
    onLeadershipLost: () => { },
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
    startDashboard: async () => 'http://127.0.0.1:3011',
    setNovaMessageHandler: (handler: any) => { captured.dashboardHandler = handler },
    stopDashboard: async () => { },
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
