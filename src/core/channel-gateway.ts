import {
    startTelegram, startWhatsApp, startDiscord, startDashboard,
    type MessageHandler, type ChannelsState, type ChannelStarterConfig,
} from './daemon-channels.js'

export type GatewayService = 'telegram' | 'whatsapp' | 'discord' | 'dashboard'
type GatewayStatus = 'stopped' | 'starting' | 'running' | 'failed'

/** One idempotent lifecycle owner for every externally visible channel. */
export class ChannelGateway {
    private status = new Map<GatewayService, GatewayStatus>()
    private starts = new Map<GatewayService, Promise<void>>()

    async start(
        service: GatewayService,
        config: any,
        handler: MessageHandler,
        state: ChannelsState,
    ): Promise<void> {
        if (this.status.get(service) === 'running') return
        const active = this.starts.get(service)
        if (active) return active

        this.status.set(service, 'starting')
        const operation = (async () => {
            try {
                if (service === 'telegram') await startTelegram(config as ChannelStarterConfig['channels']['telegram'], handler, state)
                else if (service === 'whatsapp') await startWhatsApp(config, handler, state)
                else if (service === 'discord') await startDiscord(config, handler, state)
                else await startDashboard(config, handler, state)
                this.status.set(service, 'running')
            } catch (error) {
                this.status.set(service, 'failed')
                throw error
            } finally {
                this.starts.delete(service)
            }
        })()
        this.starts.set(service, operation)
        return operation
    }

    getStatus(): Readonly<Record<GatewayService, GatewayStatus>> {
        return Object.freeze({
            telegram: this.status.get('telegram') || 'stopped',
            whatsapp: this.status.get('whatsapp') || 'stopped',
            discord: this.status.get('discord') || 'stopped',
            dashboard: this.status.get('dashboard') || 'stopped',
        })
    }
}

let gateway: ChannelGateway | null = null
export function getChannelGateway(): ChannelGateway {
    return gateway ||= new ChannelGateway()
}
