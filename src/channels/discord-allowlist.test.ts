import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// R2 H-5 regression: DiscordConfig.allowFrom/guildId were never evaluated, so
// every member of every server the bot is in (and every DM sender) reached the
// pipeline. Admission is now fail-closed on allowFrom.

const fake = vi.hoisted(() => ({ client: null as any }))
vi.mock('discord.js', () => ({
    Client: class extends EventEmitter {
        user = { tag: 'nova#0001' }
        constructor() { super(); fake.client = this }
        async login() { return 'ok' }
        async destroy() { return undefined }
    },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3, DirectMessages: 4 },
}))

const { DiscordAdapter } = await import('./discord.js')

const message = (authorId: string, guildId: string | null = null) => ({
    id: `m-${authorId}-${guildId}`, content: 'hi', createdTimestamp: 1,
    author: { id: authorId, bot: false },
    guild: guildId ? { id: guildId } : null,
    channel: { id: 'c1' },
})

async function connect(config: Record<string, unknown>) {
    const adapter = new DiscordAdapter({ token: 't', ...config } as any)
    const received: any[] = []
    adapter.onMessage(msg => received.push(msg))
    await adapter.connect()
    return { received, emit: (msg: any) => fake.client.emit('messageCreate', msg) }
}

describe('Discord admission (H-5)', () => {
    it('admits nobody without allowFrom', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { received, emit } = await connect({})
        emit(message('42'))
        emit(message('42', 'g1'))
        expect(received).toHaveLength(0)
    })

    it('admits only allow-listed authors, and only from the configured guild', async () => {
        const { received, emit } = await connect({ allowFrom: ['42'], guildId: 'g1' })
        emit(message('43'))
        emit(message('42', 'other-guild'))
        emit(message('42'))
        emit(message('42', 'g1'))
        expect(received.map(m => m.isGroup)).toEqual([false, true])
        expect(received.every(m => m.from === '42')).toBe(true)
    })
})
