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

        this.client.on('messageCreate', (msg: any) => {
            if (msg.author.bot) return

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
        })

        await this.client.login(this.config.token)
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
