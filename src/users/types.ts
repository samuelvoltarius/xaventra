/**
 * Nova - User Types
 * 
 * Multi-user support for Nova with per-user isolation
 */

// ============================================
// User Types
// ============================================

export type UserRole = 'admin' | 'user' | 'guest'

export interface TelegramIdentity {
    chatId: string
    username?: string
    firstName?: string
}

export interface WhatsAppIdentity {
    phone: string
    name?: string
}

export interface DiscordIdentity {
    id: string
    username?: string
    discriminator?: string
}

export interface UserPreferences {
    language: 'de' | 'en'
    model?: string
    timezone?: string
    notificationsEnabled: boolean
}

export interface NovaUser {
    id: string
    role: UserRole

    // Channel identities
    telegram?: TelegramIdentity
    whatsapp?: WhatsAppIdentity
    discord?: DiscordIdentity

    // Settings
    preferences: UserPreferences

    // Metadata
    createdAt: number
    lastSeenAt: number
    messageCount: number
}

// ============================================
// Session Types
// ============================================

export interface UserSession {
    userId: string
    channel: 'telegram' | 'whatsapp' | 'discord' | 'cli'
    channelId: string
    startedAt: number
    lastActivityAt: number
    messageCount: number
}

// ============================================
// Factory Functions
// ============================================

export function createUser(partial: Partial<NovaUser>): NovaUser {
    const now = Date.now()
    return {
        id: partial.id || generateUserId(),
        role: partial.role || 'user',
        telegram: partial.telegram,
        whatsapp: partial.whatsapp,
        discord: partial.discord,
        preferences: partial.preferences || {
            language: 'de',
            notificationsEnabled: true,
        },
        createdAt: partial.createdAt || now,
        lastSeenAt: partial.lastSeenAt || now,
        messageCount: partial.messageCount || 0,
    }
}

export function generateUserId(): string {
    return `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ============================================
// Lookup Helpers
// ============================================

export function getUserChannelId(user: NovaUser, channel: string): string | undefined {
    switch (channel) {
        case 'telegram': return user.telegram?.chatId
        case 'whatsapp': return user.whatsapp?.phone
        case 'discord': return user.discord?.id
        default: return undefined
    }
}
