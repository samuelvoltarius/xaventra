/**
 * Nova - VoIP Channel Adapter (Asterisk/ARI)
 * Used for phone calls and alarm functionality
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

export interface VoIPConfig {
    ariUrl: string          // Asterisk ARI URL
    username: string
    password: string
    appName: string
    callerId?: string
}

export class VoIPAdapter implements ChannelAdapter {
    type = 'voip'
    private client: any = null
    private config: VoIPConfig
    private messageHandler?: (msg: IncomingMessage) => void

    constructor(config: VoIPConfig) {
        this.config = config
    }

    async connect(): Promise<void> {
        console.log('[Nova VoIP] Connecting to Asterisk ARI...')

        const ariClient = await import('ari-client')

        this.client = await ariClient.connect(
            this.config.ariUrl,
            this.config.username,
            this.config.password
        )

        this.client.on('StasisStart', (_event: any, channel: any) => {
            console.log(`[Nova VoIP] Call started: ${channel.caller.number}`)

            const incoming: IncomingMessage = {
                id: channel.id,
                channel: 'voip',
                from: channel.caller.number ?? 'unknown',
                content: '[INCOMING_CALL]',
                timestamp: Date.now(),
                isGroup: false,
            }

            if (this.messageHandler) {
                this.messageHandler(incoming)
            }
        })

        this.client.on('StasisEnd', (_event: any, ch: any) => {
            console.log(`[Nova VoIP] Call ended: ${ch.id}`)
        })

        await this.client.start(this.config.appName)
        console.log('[Nova VoIP] Connected to Asterisk')
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.client.stop()
            this.client = null
        }
    }

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.client) throw new Error('VoIP not connected')

        // For VoIP, "sending" means initiating a call
        await this.client.channels.originate({
            endpoint: `PJSIP/${msg.to}`,
            app: this.config.appName,
            callerId: this.config.callerId ?? 'Nova',
        })

        // Play message via TTS (would need festival/espeak integration)
        console.log(`[Nova VoIP] Called ${msg.to}, message: ${msg.content}`)
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }

    // ============================================
    // Alarm Function
    // ============================================

    async makeAlarmCall(phoneNumber: string, message: string): Promise<void> {
        if (!this.client) throw new Error('VoIP not connected')

        console.log(`[Nova VoIP] Making alarm call to ${phoneNumber}`)

        const channel = await this.client.channels.originate({
            endpoint: `PJSIP/${phoneNumber}`,
            app: this.config.appName,
            callerId: 'Nova Alarm',
            variables: { ALARM_MESSAGE: message },
        })

        // The dialplan would handle playing the alarm message
        return channel.id
    }
}

export function createVoIPAdapter(config: VoIPConfig): VoIPAdapter {
    return new VoIPAdapter(config)
}

export default { VoIPAdapter, createVoIPAdapter }
