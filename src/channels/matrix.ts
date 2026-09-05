/**
 * Nova - Matrix Channel Adapter
 */

import type { ChannelAdapter } from '../core/runtime.js'
import type { IncomingMessage, OutgoingMessage } from '../core/types.js'

export interface MatrixConfig {
    homeserverUrl: string
    userId: string
    accessToken: string
    allowFrom?: string[]
}

export class MatrixAdapter implements ChannelAdapter {
    type = 'matrix'
    private client: any = null
    private config: MatrixConfig
    private messageHandler?: (msg: IncomingMessage) => void

    constructor(config: MatrixConfig) {
        this.config = config
    }

    async connect(): Promise<void> {
        console.log('[Nova Matrix] Connecting...')
        const sdk = await import('matrix-js-sdk')

        this.client = sdk.createClient({
            baseUrl: this.config.homeserverUrl,
            userId: this.config.userId,
            accessToken: this.config.accessToken,
        })

        this.client.on('Room.timeline', (event: any, room: any) => {
            if (event.getType() !== 'm.room.message') return
            if (event.getSender() === this.config.userId) return

            const incoming: IncomingMessage = {
                id: event.getId(),
                channel: 'matrix',
                from: event.getSender(),
                content: event.getContent().body ?? '',
                timestamp: event.getTs(),
                isGroup: true,
                groupId: room.roomId,
            }

            if (this.messageHandler) {
                this.messageHandler(incoming)
            }
        })

        await this.client.startClient({ initialSyncLimit: 10 })
        console.log('[Nova Matrix] Connected')
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.client.stopClient()
            this.client = null
        }
    }

    async send(msg: OutgoingMessage): Promise<void> {
        if (!this.client) throw new Error('Matrix not connected')

        await this.client.sendTextMessage(msg.to, msg.content)
    }

    onMessage(handler: (msg: IncomingMessage) => void): void {
        this.messageHandler = handler
    }
}

export function createMatrixAdapter(config: MatrixConfig): MatrixAdapter {
    return new MatrixAdapter(config)
}

export default { MatrixAdapter, createMatrixAdapter }
