/**
 * Nova - User Store
 * 
 * Persistent storage for user data with lookup by channel ID
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { NovaUser, createUser, generateUserId } from './types.js'

// ============================================
// Store State
// ============================================

interface UserStoreState {
    users: Record<string, NovaUser>
    indexes: {
        telegram: Record<string, string>  // chatId -> userId
        whatsapp: Record<string, string>  // phone -> userId
        discord: Record<string, string>   // discordId -> userId
    }
}

let state: UserStoreState = {
    users: {},
    indexes: { telegram: {}, whatsapp: {}, discord: {} }
}

let storePath = ''
let initialized = false

// ============================================
// Initialization
// ============================================

export function initUserStore(dataDir: string = '.nova-users'): void {
    storePath = join(process.cwd(), dataDir, 'users.json')

    // Ensure directory exists
    const dir = dirname(storePath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    // Load existing data
    if (existsSync(storePath)) {
        try {
            const data = JSON.parse(readFileSync(storePath, 'utf-8'))
            state = data
            console.log(`[Users] Loaded ${Object.keys(state.users).length} users`)
        } catch (err) {
            console.error(`[Users] Failed to load: ${err}`)
        }
    }

    initialized = true
}

function save(): void {
    if (!initialized) return
    writeFileSync(storePath, JSON.stringify(state, null, 2))
}

// ============================================
// User CRUD
// ============================================

export function getUser(userId: string): NovaUser | undefined {
    return state.users[userId]
}

export function getAllUsers(): NovaUser[] {
    return Object.values(state.users)
}

export function createOrGetUser(channel: 'telegram' | 'whatsapp' | 'discord', channelId: string, meta?: Partial<NovaUser>): NovaUser {
    // Check if user exists by channel
    const existingId = state.indexes[channel]?.[channelId]
    if (existingId && state.users[existingId]) {
        const user = state.users[existingId]
        user.lastSeenAt = Date.now()
        save()
        return user
    }

    // Create new user
    const userId = generateUserId()
    const user = createUser({
        id: userId,
        ...meta,
    })

    // Set channel identity
    switch (channel) {
        case 'telegram':
            user.telegram = { chatId: channelId, ...meta?.telegram }
            break
        case 'whatsapp':
            user.whatsapp = { phone: channelId, ...meta?.whatsapp }
            break
        case 'discord':
            user.discord = { id: channelId, ...meta?.discord }
            break
    }

    // Save
    state.users[userId] = user
    state.indexes[channel][channelId] = userId
    save()

    console.log(`[Users] Created new user: ${userId} (${channel}:${channelId})`)
    return user
}

export function updateUser(userId: string, updates: Partial<NovaUser>): NovaUser | undefined {
    const user = state.users[userId]
    if (!user) return undefined

    Object.assign(user, updates)
    save()
    return user
}

export function deleteUser(userId: string): boolean {
    const user = state.users[userId]
    if (!user) return false

    // Remove from indexes
    if (user.telegram?.chatId) delete state.indexes.telegram[user.telegram.chatId]
    if (user.whatsapp?.phone) delete state.indexes.whatsapp[user.whatsapp.phone]
    if (user.discord?.id) delete state.indexes.discord[user.discord.id]

    delete state.users[userId]
    save()
    return true
}

// ============================================
// Lookup Functions
// ============================================

export function getUserByTelegram(chatId: string): NovaUser | undefined {
    const userId = state.indexes.telegram[chatId]
    return userId ? state.users[userId] : undefined
}

export function getUserByWhatsApp(phone: string): NovaUser | undefined {
    const userId = state.indexes.whatsapp[phone]
    return userId ? state.users[userId] : undefined
}

export function getUserByDiscord(discordId: string): NovaUser | undefined {
    const userId = state.indexes.discord[discordId]
    return userId ? state.users[userId] : undefined
}

export function getUserByChannel(channel: string, channelId: string): NovaUser | undefined {
    switch (channel) {
        case 'telegram': return getUserByTelegram(channelId)
        case 'whatsapp': return getUserByWhatsApp(channelId)
        case 'discord': return getUserByDiscord(channelId)
        default: return undefined
    }
}

// ============================================
// Statistics
// ============================================

export function getUserStats(): { total: number; byRole: Record<string, number>; byChannel: Record<string, number> } {
    const users = Object.values(state.users)
    return {
        total: users.length,
        byRole: {
            admin: users.filter(u => u.role === 'admin').length,
            user: users.filter(u => u.role === 'user').length,
            guest: users.filter(u => u.role === 'guest').length,
        },
        byChannel: {
            telegram: Object.keys(state.indexes.telegram).length,
            whatsapp: Object.keys(state.indexes.whatsapp).length,
            discord: Object.keys(state.indexes.discord).length,
        }
    }
}

// ============================================
// Admin Functions
// ============================================

export function setUserRole(userId: string, role: 'admin' | 'user' | 'guest'): boolean {
    const user = state.users[userId]
    if (!user) return false
    user.role = role
    save()
    return true
}

export function getAdmins(): NovaUser[] {
    return Object.values(state.users).filter(u => u.role === 'admin')
}
