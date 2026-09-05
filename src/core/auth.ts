/**
 * Nova - Authorization Layer
 * 
 * Controls who can:
 * 1. Access the Dashboard (password)
 * 2. Send messages to Nova (phone whitelist)
 * 3. Execute commands (permission levels)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export type PermissionLevel = 'owner' | 'admin' | 'user' | 'guest' | 'blocked'

export interface AuthUser {
    id: string
    phone?: string           // WhatsApp/Telegram number
    telegramId?: string      // Telegram user ID
    discordId?: string       // Discord user ID
    name?: string
    level: PermissionLevel
    createdAt: number
    lastSeen?: number
    commandsExecuted: number
    blocked: boolean
    blockedReason?: string
}

export interface DashboardSession {
    token: string
    createdAt: number
    expiresAt: number
    ip?: string
}

export interface AuthConfig {
    // Dashboard
    dashboardPassword?: string      // Hashed password
    dashboardPasswordPlain?: string // For initial setup (gets hashed)
    sessionDurationMs: number       // Default: 24h

    // Phone whitelist
    ownerPhone?: string             // Owner phone number (full access)
    allowedPhones: string[]         // Whitelist of phone numbers
    allowUnknownUsers: boolean      // Allow non-whitelisted users?
    unknownUserLevel: PermissionLevel

    // Rate limiting
    maxCommandsPerMinute: number
    maxMessagesPerMinute: number
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: AuthConfig = {
    sessionDurationMs: 24 * 60 * 60 * 1000, // 24 hours
    allowedPhones: [],
    allowUnknownUsers: false,
    unknownUserLevel: 'guest',
    maxCommandsPerMinute: 10,
    maxMessagesPerMinute: 30,
}

// ============================================
// Permission Definitions
// ============================================

const PERMISSIONS: Record<PermissionLevel, Set<string>> = {
    owner: new Set([
        '*',                    // All permissions
    ]),
    admin: new Set([
        'chat',
        'command',
        'command.factory',
        'command.memory',
        'command.model',
        'command.status',
        'command.help',
        'dashboard.view',
        'dashboard.control',
    ]),
    user: new Set([
        'chat',
        'command.help',
        'command.status',
        'command.alarm',
        'command.memory.read',
    ]),
    guest: new Set([
        'chat',
        'command.help',
    ]),
    blocked: new Set([]),   // No permissions
}

// ============================================
// Auth Manager Class
// ============================================

export class AuthManager {
    private config: AuthConfig
    private users: Map<string, AuthUser> = new Map()
    private sessions: Map<string, DashboardSession> = new Map()
    private rateLimits: Map<string, { commands: number[], messages: number[] }> = new Map()
    private dataDir: string

    constructor(config: Partial<AuthConfig> = {}, dataDir = '.nova-auth') {
        this.config = { ...DEFAULT_CONFIG, ...config }
        this.dataDir = dataDir

        // Hash password if provided in plain
        if (this.config.dashboardPasswordPlain) {
            this.config.dashboardPassword = this.hashPassword(this.config.dashboardPasswordPlain)
            delete this.config.dashboardPasswordPlain
        }

        // Add owner phone to whitelist
        if (this.config.ownerPhone && !this.config.allowedPhones.includes(this.config.ownerPhone)) {
            this.config.allowedPhones.push(this.config.ownerPhone)
        }

        this.load()
    }

    // ============================================
    // Dashboard Authentication
    // ============================================

    /**
     * Set dashboard password.
     */
    setDashboardPassword(password: string): void {
        this.config.dashboardPassword = this.hashPassword(password)
        this.save()
        console.log('[Auth] Dashboard password set')
    }

    /**
     * Verify dashboard password and create session.
     */
    loginDashboard(password: string, ip?: string): DashboardSession | null {
        if (!this.config.dashboardPassword) {
            // No password set - allow access (first-time setup)
            console.log('[Auth] No dashboard password set - allowing access')
            return this.createSession(ip)
        }

        const hashedInput = this.hashPassword(password)

        // Timing-safe comparison
        try {
            const inputBuf = Buffer.from(hashedInput, 'hex')
            const storedBuf = Buffer.from(this.config.dashboardPassword, 'hex')

            if (inputBuf.length === storedBuf.length && timingSafeEqual(inputBuf, storedBuf)) {
                console.log('[Auth] Dashboard login successful')
                return this.createSession(ip)
            }
        } catch {
            // Length mismatch or other error
        }

        console.log('[Auth] Dashboard login failed')
        return null
    }

    /**
     * Verify session token.
     */
    verifySession(token: string): boolean {
        const session = this.sessions.get(token)
        if (!session) return false

        if (Date.now() > session.expiresAt) {
            this.sessions.delete(token)
            return false
        }

        return true
    }

    /**
     * Logout/invalidate session.
     */
    logoutDashboard(token: string): void {
        this.sessions.delete(token)
    }

    private createSession(ip?: string): DashboardSession {
        const session: DashboardSession = {
            token: randomBytes(32).toString('hex'),
            createdAt: Date.now(),
            expiresAt: Date.now() + this.config.sessionDurationMs,
            ip,
        }

        this.sessions.set(session.token, session)
        return session
    }

    private hashPassword(password: string): string {
        return createHash('sha256').update(password).digest('hex')
    }

    // ============================================
    // User Management (Phone Whitelist)
    // ============================================

    /**
     * Check if a phone number is allowed.
     */
    isPhoneAllowed(phone: string): boolean {
        const normalized = this.normalizePhone(phone)

        // Check blocked
        const user = this.findUserByPhone(normalized)
        if (user?.blocked) return false

        // Owner always allowed
        if (this.config.ownerPhone && normalized === this.normalizePhone(this.config.ownerPhone)) {
            return true
        }

        // Check whitelist
        if (this.config.allowedPhones.some(p => this.normalizePhone(p) === normalized)) {
            return true
        }

        // Allow unknown users?
        return this.config.allowUnknownUsers
    }

    /**
     * Get or create user for a phone number.
     */
    getOrCreateUser(phone: string, name?: string): AuthUser {
        const normalized = this.normalizePhone(phone)

        let user = this.findUserByPhone(normalized)
        if (user) {
            user.lastSeen = Date.now()
            this.save()
            return user
        }

        // Determine level
        let level: PermissionLevel = this.config.unknownUserLevel

        if (this.config.ownerPhone && normalized === this.normalizePhone(this.config.ownerPhone)) {
            level = 'owner'
        } else if (this.config.allowedPhones.some(p => this.normalizePhone(p) === normalized)) {
            level = 'user'
        }

        user = {
            id: randomBytes(8).toString('hex'),
            phone: normalized,
            name,
            level,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            commandsExecuted: 0,
            blocked: false,
        }

        this.users.set(user.id, user)
        this.save()

        console.log(`[Auth] New user: ${normalized} (${level})`)
        return user
    }

    /**
     * Add phone to whitelist.
     */
    addAllowedPhone(phone: string, level: PermissionLevel = 'user'): void {
        const normalized = this.normalizePhone(phone)

        if (!this.config.allowedPhones.includes(normalized)) {
            this.config.allowedPhones.push(normalized)
        }

        // Update existing user or create new
        let user = this.findUserByPhone(normalized)
        if (user) {
            user.level = level
            user.blocked = false
        } else {
            user = {
                id: randomBytes(8).toString('hex'),
                phone: normalized,
                level,
                createdAt: Date.now(),
                commandsExecuted: 0,
                blocked: false,
            }
            this.users.set(user.id, user)
        }

        this.save()
        console.log(`[Auth] Added to whitelist: ${normalized} (${level})`)
    }

    /**
     * Remove phone from whitelist.
     */
    removeAllowedPhone(phone: string): void {
        const normalized = this.normalizePhone(phone)
        this.config.allowedPhones = this.config.allowedPhones.filter(
            p => this.normalizePhone(p) !== normalized
        )
        this.save()
        console.log(`[Auth] Removed from whitelist: ${normalized}`)
    }

    /**
     * Block a user.
     */
    blockUser(userId: string, reason?: string): void {
        const user = this.users.get(userId)
        if (user) {
            user.blocked = true
            user.blockedReason = reason
            this.save()
            console.log(`[Auth] Blocked user: ${userId} - ${reason}`)
        }
    }

    /**
     * Unblock a user.
     */
    unblockUser(userId: string): void {
        const user = this.users.get(userId)
        if (user) {
            user.blocked = false
            delete user.blockedReason
            this.save()
            console.log(`[Auth] Unblocked user: ${userId}`)
        }
    }

    private findUserByPhone(phone: string): AuthUser | undefined {
        const normalized = this.normalizePhone(phone)
        return Array.from(this.users.values()).find(
            u => u.phone && this.normalizePhone(u.phone) === normalized
        )
    }

    private normalizePhone(phone: string): string {
        // Remove all non-digit characters except leading +
        return phone.replace(/[^\d+]/g, '').replace(/^\+/, '')
    }

    // ============================================
    // Permission Checking
    // ============================================

    /**
     * Check if user has permission.
     */
    hasPermission(userId: string, permission: string): boolean {
        const user = this.users.get(userId)
        if (!user || user.blocked) return false

        const perms = PERMISSIONS[user.level]

        // Owner has all permissions
        if (perms.has('*')) return true

        // Check exact permission
        if (perms.has(permission)) return true

        // Check parent permission (e.g., 'command' covers 'command.help')
        const parts = permission.split('.')
        for (let i = parts.length - 1; i > 0; i--) {
            const parent = parts.slice(0, i).join('.')
            if (perms.has(parent)) return true
        }

        return false
    }

    /**
     * Check if user can execute a command.
     */
    canExecuteCommand(userId: string, command: string): boolean {
        const user = this.users.get(userId)
        if (!user || user.blocked) return false

        // Check rate limit
        if (!this.checkRateLimit(userId, 'commands', this.config.maxCommandsPerMinute)) {
            console.log(`[Auth] Rate limit exceeded for user: ${userId}`)
            return false
        }

        // Check permission
        const permission = `command.${command.toLowerCase()}`
        return this.hasPermission(userId, permission)
    }

    /**
     * Record command execution.
     */
    recordCommand(userId: string): void {
        const user = this.users.get(userId)
        if (user) {
            user.commandsExecuted++
            this.addRateLimitEntry(userId, 'commands')
        }
    }

    // ============================================
    // Rate Limiting
    // ============================================

    private checkRateLimit(userId: string, type: 'commands' | 'messages', limit: number): boolean {
        const userLimits = this.rateLimits.get(userId)
        if (!userLimits) return true

        const now = Date.now()
        const oneMinuteAgo = now - 60000

        const entries = userLimits[type].filter(t => t > oneMinuteAgo)
        userLimits[type] = entries

        return entries.length < limit
    }

    private addRateLimitEntry(userId: string, type: 'commands' | 'messages'): void {
        if (!this.rateLimits.has(userId)) {
            this.rateLimits.set(userId, { commands: [], messages: [] })
        }

        this.rateLimits.get(userId)![type].push(Date.now())
    }

    // ============================================
    // Getters
    // ============================================

    getUser(userId: string): AuthUser | undefined {
        return this.users.get(userId)
    }

    getAllUsers(): AuthUser[] {
        return Array.from(this.users.values())
    }

    getWhitelist(): string[] {
        return [...this.config.allowedPhones]
    }

    getOwnerPhone(): string | undefined {
        return this.config.ownerPhone
    }

    // ============================================
    // Persistence
    // ============================================

    private load(): void {
        try {
            const usersPath = join(this.dataDir, 'users.json')
            if (existsSync(usersPath)) {
                const data = JSON.parse(readFileSync(usersPath, 'utf-8'))
                this.users = new Map(Object.entries(data))
                console.log(`[Auth] Loaded ${this.users.size} users`)
            }

            const configPath = join(this.dataDir, 'config.json')
            if (existsSync(configPath)) {
                const savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
                this.config = { ...this.config, ...savedConfig }
            }
        } catch (err) {
            console.error('[Auth] Failed to load:', err)
        }
    }

    private save(): void {
        try {
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true })
            }

            writeFileSync(
                join(this.dataDir, 'users.json'),
                JSON.stringify(Object.fromEntries(this.users), null, 2)
            )

            writeFileSync(
                join(this.dataDir, 'config.json'),
                JSON.stringify({
                    dashboardPassword: this.config.dashboardPassword,
                    ownerPhone: this.config.ownerPhone,
                    allowedPhones: this.config.allowedPhones,
                    allowUnknownUsers: this.config.allowUnknownUsers,
                    unknownUserLevel: this.config.unknownUserLevel,
                }, null, 2)
            )
        } catch (err) {
            console.error('[Auth] Failed to save:', err)
        }
    }
}

// ============================================
// Global Instance
// ============================================

let authInstance: AuthManager | null = null

export function getAuth(): AuthManager {
    if (!authInstance) {
        authInstance = new AuthManager()
    }
    return authInstance
}

export function createAuth(config?: Partial<AuthConfig>, dataDir?: string): AuthManager {
    return new AuthManager(config, dataDir)
}

export default { AuthManager, getAuth, createAuth }
