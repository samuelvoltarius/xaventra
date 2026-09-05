/**
 * Nova - Slack Channel Adapter
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

export interface SlackConfig {
    botToken: string        // xoxb-...
    appToken: string        // xapp-...
    allowFrom?: string[]
}

export class SlackAdapter implements ChannelAdapter {
    type = 'slack'
    private app: any = null
    private config: SlackConfig
    private messageHandler?: (msg: IncomingMessage) => void

    constructor(config: SlackConfig) {
        this.config = config
    }

    async connect(): Promise<void> {
        console.log('[Nova Slack] Connecting...')
        const { App } = await import('@slack/bolt')

        this.app = new App({
            token: this.config.botToken,
            appToken: this.config.appToken,
            socketMode: true,
        })

        this.app.message(async ({ message, say }: any) => {
            if (message.bot_id) return

            const incoming: IncomingMessage = {
                id: message.ts,
                channel: 'slack',
                from: message.user,
                content: message.text ?? '',
                timestamp: parseFloat(message.ts) * 1000,
                isGroup: message.channel_type === 'channel' || message.channel_type === 'group',
                groupId: message.channel,
            }

            if (this.messageHandler) {
                this.messageHandler(incoming)
            }
        })

        await this.app.start()
        console.log('[Nova Slack] Connected')
    }

    async disconnect(): Promise<void> {
        if (this.app) {
            await this.app.stop()
            this.app = null
        }
    }

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.app) throw new Error('Slack not connected')

        await this.app.client.chat.postMessage({
            channel: msg.to,
            text: msg.content,
        })
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }
}

export function createSlackAdapter(config: SlackConfig): SlackAdapter {
    return new SlackAdapter(config)
}

export default { SlackAdapter, createSlackAdapter }
