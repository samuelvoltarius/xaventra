/**
 * Nova - Message Channel Utilities
 * 
 * Utilities for message channel handling.
 */

export type MessageChannel = 'telegram' | 'whatsapp' | 'discord' | 'slack' | 'signal' | 'imessage' | 'cli' | 'api'

export interface ChannelMessage {
    id: string
    channel: MessageChannel
    content: string
    from: string
    to?: string
    timestamp: Date
    metadata?: Record<string, unknown>
}

export function isValidChannel(channel: string): channel is MessageChannel {
    return ['telegram', 'whatsapp', 'discord', 'slack', 'signal', 'imessage', 'cli', 'api'].includes(channel)
}

export function getChannelDisplayName(channel: MessageChannel): string {
    const names: Record<MessageChannel, string> = {
        telegram: 'Telegram',
        whatsapp: 'WhatsApp',
        discord: 'Discord',
        slack: 'Slack',
        signal: 'Signal',
        imessage: 'iMessage',
        cli: 'CLI',
        api: 'API',
    }
    return names[channel] || channel
}

export function getChannelEmoji(channel: MessageChannel): string {
    const emojis: Record<MessageChannel, string> = {
        telegram: '📱',
        whatsapp: '💬',
        discord: '🎮',
        slack: '💼',
        signal: '🔒',
        imessage: '🍎',
        cli: '💻',
        api: '🔌',
    }
    return emojis[channel] || '📨'
}

export default {
    isValidChannel,
    getChannelDisplayName,
    getChannelEmoji,
}
