/**
 * Nova - Signal Channel Adapter
 * Uses signal-cli REST API
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

export interface SignalConfig {
    apiUrl: string          // signal-cli-rest-api URL
    phoneNumber: string     // Bot's phone number
    allowFrom?: string[]
}

export class SignalAdapter implements ChannelAdapter {
    type = 'signal'
    private config: SignalConfig
    private messageHandler?: (msg: IncomingMessage) => void
    private pollInterval?: NodeJS.Timeout

    constructor(config: SignalConfig) {
        this.config = config
    }

    async connect(): Promise<void> {
        console.log('[Nova Signal] Connecting...')

        // Poll for messages
        this.pollInterval = setInterval(() => this.pollMessages(), 2000)
        console.log(`[Nova Signal] Connected as ${this.config.phoneNumber}`)
    }

    private async pollMessages(): Promise<void> {
        try {
            const response = await fetch(
                `${this.config.apiUrl}/v1/receive/${this.config.phoneNumber}`
            )

            if (!response.ok) return

            const messages = await response.json() as any[]

            for (const msg of messages) {
                if (!msg.envelope?.dataMessage?.message) continue

                const incoming: IncomingMessage = {
                    id: `${msg.envelope.timestamp}`,
                    channel: 'signal',
                    from: msg.envelope.source,
                    content: msg.envelope.dataMessage.message,
                    timestamp: msg.envelope.timestamp,
                    isGroup: !!msg.envelope.dataMessage.groupInfo,
                    groupId: msg.envelope.dataMessage.groupInfo?.groupId,
                }

                if (this.messageHandler) {
                    this.messageHandler(incoming)
                }
            }
        } catch {
            // Ignore poll errors
        }
    }

    async disconnect(): Promise<void> {
        if (this.pollInterval) {
            clearInterval(this.pollInterval)
            this.pollInterval = undefined
        }
    }

    async send(msg: OutgoingMessage): Promise<void> {
        const body: any = {
            message: msg.content,
            number: this.config.phoneNumber,
        }

        if (msg.to.includes('@')) {
            body.recipients = [msg.to]
        } else {
            body.recipients = [msg.to]
        }

        await fetch(`${this.config.apiUrl}/v2/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }
}

export function createSignalAdapter(config: SignalConfig): SignalAdapter {
    return new SignalAdapter(config)
}

export default { SignalAdapter, createSignalAdapter }
