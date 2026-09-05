/**
 * Nova - Channel Registry
 * 
 * Unified export of all channel adapters
 */

// Channel Types
export type { ChannelAdapter } from '../core/runtime.js'
export type { IncomingMessage, OutgoingMessage, ChannelType } from '../core/types.js'

// WhatsApp
export { WhatsAppAdapter, createWhatsAppAdapter } from './whatsapp.js'
export type { WhatsAppConfig } from './whatsapp.js'

// Telegram
export { TelegramAdapter, createTelegramAdapter } from './telegram.js'
export type { TelegramConfig } from './telegram.js'

// Discord
export { DiscordAdapter, createDiscordAdapter } from './discord.js'
export type { DiscordConfig } from './discord.js'

// Matrix
export { MatrixAdapter, createMatrixAdapter } from './matrix.js'
export type { MatrixConfig } from './matrix.js'

// Signal
export { SignalAdapter, createSignalAdapter } from './signal.js'
export type { SignalConfig } from './signal.js'

// Slack
export { SlackAdapter, createSlackAdapter } from './slack.js'
export type { SlackConfig } from './slack.js'

// VoIP
export { VoIPAdapter, createVoIPAdapter } from './voip.js'
export type { VoIPConfig } from './voip.js'

// ============================================
// Channel Factory
// ============================================

import type { ChannelAdapter } from '../core/runtime.js'
import { WhatsAppAdapter, type WhatsAppConfig } from './whatsapp.js'
import { TelegramAdapter, type TelegramConfig } from './telegram.js'
import { DiscordAdapter, type DiscordConfig } from './discord.js'
import { MatrixAdapter, type MatrixConfig } from './matrix.js'
import { SignalAdapter, type SignalConfig } from './signal.js'
import { SlackAdapter, type SlackConfig } from './slack.js'
import { VoIPAdapter, type VoIPConfig } from './voip.js'

export type ChannelConfig =
    | { type: 'whatsapp'; config: WhatsAppConfig }
    | { type: 'telegram'; config: TelegramConfig }
    | { type: 'discord'; config: DiscordConfig }
    | { type: 'matrix'; config: MatrixConfig }
    | { type: 'signal'; config: SignalConfig }
    | { type: 'slack'; config: SlackConfig }
    | { type: 'voip'; config: VoIPConfig }

export function createChannel(channelConfig: ChannelConfig): ChannelAdapter {
    switch (channelConfig.type) {
        case 'whatsapp':
            return new WhatsAppAdapter(channelConfig.config)
        case 'telegram':
            return new TelegramAdapter(channelConfig.config)
        case 'discord':
            return new DiscordAdapter(channelConfig.config)
        case 'matrix':
            return new MatrixAdapter(channelConfig.config)
        case 'signal':
            return new SignalAdapter(channelConfig.config)
        case 'slack':
            return new SlackAdapter(channelConfig.config)
        case 'voip':
            return new VoIPAdapter(channelConfig.config)
        default:
            throw new Error(`Unknown channel type: ${(channelConfig as any).type}`)
    }
}

// ============================================
// Available Channels
// ============================================

export const AVAILABLE_CHANNELS = [
    'whatsapp',
    'telegram',
    'discord',
    'matrix',
    'signal',
    'slack',
    'voip',
] as const

export type AvailableChannel = typeof AVAILABLE_CHANNELS[number]
