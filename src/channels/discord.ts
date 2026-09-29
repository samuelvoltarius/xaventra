/**
 * Nova - Discord Channel Adapter
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

export interface DiscordConfig {
    token: string
    allowFrom?: string[]
    guildId?: string
}

export class DiscordAdapter implements ChannelAdapter {
    type = 'discord'
    private client: any = null
    private config: DiscordConfig
    private messageHandler?: (msg: IncomingMessage) => void
    private warnedEmptyAllowlist = false

    constructor(config: DiscordConfig) {
        this.config = config
    }

    async connect(): Promise<void> {
        console.log('[Nova Discord] Connecting...')
        const { Client, GatewayIntentBits } = await import('discord.js')

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
        })

        this.client.on('ready', () => {
            console.log(`[Nova Discord] Connected as ${this.client.user?.tag}`)
        })

        this.client.on('messageCreate', (msg: any) => this.handleMessageCreate(msg))

        await this.client.login(this.config.token)
    }

    /**
     * H-5: fail-closed admission. Only authors listed in allowFrom (exact
     * Discord user ids) reach the pipeline; an empty or missing allowFrom
     * admits nobody. With guildId set, server messages from other guilds are
     * dropped.
     */
    handleMessageCreate(msg: any): void {
        if (!msg?.author || msg.author.bot) return
        const allowed = (this.config.allowFrom || []).map(entry => String(entry ?? '').trim()).filter(Boolean)
        if (!allowed.length) {
            if (!this.warnedEmptyAllowlist) {
                this.warnedEmptyAllowlist = true
                console.warn('[Nova Discord] allowFrom ist leer: alle Discord-Nachrichten werden ignoriert (fail-closed)')
            }
            return
        }
        if (!allowed.includes(String(msg.author.id))) return
        if (this.config.guildId && msg.guild && String(msg.guild.id) !== String(this.config.guildId)) return

        const incoming: IncomingMessage = {
            id: msg.id,
            channel: 'discord',
            from: msg.author.id,
            content: msg.content,
            timestamp: msg.createdTimestamp,
            isGroup: msg.guild !== null,
            groupId: msg.channel.id,
        }

        if (this.messageHandler) {
            this.messageHandler(incoming)
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy()
            this.client = null
        }
    }

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.client) throw new Error('Discord not connected')

        const channel = await this.client.channels.fetch(msg.to)
        if (channel?.isTextBased?.()) {
            await channel.send(msg.content)
        }
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }
}

export function createDiscordAdapter(config: DiscordConfig): DiscordAdapter {
    return new DiscordAdapter(config)
}

export default { DiscordAdapter, createDiscordAdapter }
