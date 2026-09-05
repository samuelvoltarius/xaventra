/**
 * Multi-User Middleware — Spacebot-inspired multi-user support
 *
 * Features:
 * 1. Auth Enforcement — check permissions on every message
 * 2. Tool Restrictions — per-role tool filtering
 * 3. Per-User Memory — isolated context per user
 * 4. Group Chat — track who speaks, per-user roles in shared chats
 * 5. Message Coalescing — batch rapid-fire messages
 * 6. User Onboarding — auto-welcome new users
 * 7. Non-blocking Channel — async worker for heavy tasks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'multi-user')

// ============================================
// 1. Auth Enforcement
// ============================================

export type UserPermission = 'owner' | 'admin' | 'user' | 'guest' | 'blocked'

export interface UserRecord {
    id: string
    name?: string
    permission: UserPermission
    firstSeen: number
    lastSeen: number
    messageCount: number
    channel: string
    onboarded: boolean
}

export function isConfiguredOwner(userId: string, channel: string, allowFrom: string[]): boolean {
    const rawId = userId.includes(':') ? userId.slice(userId.indexOf(':') + 1) : userId
    const candidates = new Set([userId, rawId, `${channel}:${rawId}`])
    return allowFrom.some(value => candidates.has(String(value).trim()))
}

export function reconcileConfiguredOwner(
    user: UserRecord,
    allowFrom: string[],
): { user: UserRecord; changed: boolean } {
    if (!isConfiguredOwner(user.id, user.channel, allowFrom) || user.permission === 'owner') {
        return { user, changed: false }
    }
    return { user: { ...user, permission: 'owner' }, changed: true }
}

type UserReference = { id: string; user: UserRecord; error?: undefined } | { id?: undefined; user?: undefined; error: string }

/** Resolve a stable user id from either id or display name. Ambiguous display
 * names fail closed so an administrative command cannot target the wrong user. */
export function resolveUserReference(records: Record<string, UserRecord>, reference: string): UserReference {
    const query = reference.trim().toLocaleLowerCase('de')
    if (!query) return { error: 'Kein User angegeben.' }
    const exactId = Object.entries(records).find(([id]) => id.toLocaleLowerCase('de') === query)
    if (exactId) return { id: exactId[0], user: exactId[1] }
    const byName = Object.entries(records).filter(([, user]) => user.name?.trim().toLocaleLowerCase('de') === query)
    if (byName.length === 1) return { id: byName[0][0], user: byName[0][1] }
    if (byName.length > 1) return { error: `Name "${reference}" ist nicht eindeutig. Bitte die User-ID verwenden.` }
    return { error: `User "${reference}" nicht gefunden.` }
}

function resolveCurrentUser(reference: string): UserReference {
    return resolveUserReference(users, reference)
}

let users: Record<string, UserRecord> = {}

export function loadUsers(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        const path = join(DATA_DIR, 'users.json')
        if (existsSync(path)) {
            users = JSON.parse(readFileSync(path, 'utf-8'))
            const allowFrom = getConfigAllowFrom()
            let changed = false
            for (const [id, existing] of Object.entries(users)) {
                const reconciled = reconcileConfiguredOwner(existing, allowFrom)
                users[id] = reconciled.user
                changed ||= reconciled.changed
            }
            if (changed) saveUsers()
        }
    } catch { }
}

function saveUsers(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2))
    } catch { }
}

export function getOrCreateUser(userId: string, channel: string, name?: string): UserRecord {
    const configAllowFrom = getConfigAllowFrom()
    if (!users[userId]) {
        // First message from config's allowFrom → owner, else guest
        //
        // NovaOS: Hier sitzt genau EIN Mensch physisch vor der Maschine, und
        // die Schnittstelle horcht ausschliesslich auf 127.0.0.1. Eine
        // Gast-Rolle gibt es hier nicht — sie verhinderte, dass ueber das
        // Terminal ueberhaupt etwas installiert werden konnte, waehrend
        // derselbe Auftrag ueber die Desktop-App lief. Am 30.08.2026 gemessen.
        const istNovaOS = process.env.NOVA_OS_MODE === 'true'
        const isOwner = istNovaOS || isConfiguredOwner(userId, channel, configAllowFrom)
        const isKnown = configAllowFrom.length === 0 // No whitelist = open

        users[userId] = {
            id: userId,
            name,
            permission: isOwner ? 'owner' : (isKnown ? 'user' : 'guest'),
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            messageCount: 0,
            channel,
            onboarded: false,
        }
        saveUsers()
        console.log(`[MultiUser] Neuer User: ${userId} (${users[userId].permission})`)
    }

    const reconciled = reconcileConfiguredOwner(users[userId], configAllowFrom)
    if (reconciled.changed) {
        users[userId] = reconciled.user
        saveUsers()
        console.log(`[MultiUser] Konfigurierter Owner wiederhergestellt: ${userId}`)
    }

    users[userId].lastSeen = Date.now()
    users[userId].messageCount++
    if (name) users[userId].name = name
    return users[userId]
}

export function setUserPermission(userId: string, permission: UserPermission): boolean {
    if (!users[userId]) return false
    users[userId].permission = permission
    saveUsers()
    return true
}

export function getUserPermission(userId: string): UserPermission {
    // Unbekannt heisst in NovaOS nicht 'Gast', sondern 'der Mensch davor'.
    return users[userId]?.permission
        || (process.env.NOVA_OS_MODE === 'true' ? 'owner' : 'guest')
}

export function listUsers(): UserRecord[] {
    return Object.values(users)
}

export function isBlocked(userId: string): boolean {
    return users[userId]?.permission === 'blocked'
}

function getConfigAllowFrom(): string[] {
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            return config.channels?.telegram?.allowFrom || config.telegram?.allowFrom || config.allowFrom || []
        }
    } catch { }
    return []
}

// ============================================
// 1b. Permission Check Result
// ============================================

export interface AuthCheckResult {
    allowed: boolean
    reason?: string
    permission: UserPermission
    isNewUser: boolean
    user: UserRecord
}

export function checkAuth(userId: string, channel: string, name?: string): AuthCheckResult {
    const isNew = !users[userId]
    const user = getOrCreateUser(userId, channel, name)

    if (user.permission === 'blocked') {
        return { allowed: false, reason: 'Du bist blockiert.', permission: 'blocked', isNewUser: false, user }
    }

    // Guests can chat but with limitations
    return { allowed: true, permission: user.permission, isNewUser: isNew, user }
}

// ============================================
// 2. Tool Restrictions per Role
// ============================================

const TOOL_PERMISSIONS: Record<UserPermission, { allowed: string[] | '*'; denied: string[] }> = {
    owner: { allowed: '*', denied: [] },
    admin: { allowed: '*', denied: ['self_evolve'] },
    user: {
        allowed: [
            'google_search', 'fetch_url', 'read_url',
            'read_file', 'list_directory', 'codebase_search',
            'generate_image', 'reminder', 'timer',
            'weather', 'translate', 'calculate',
        ],
        denied: [
            'run_command', 'ssh_exec', 'write_file', 'delete_file',
            'self_evolve', 'edit_config', 'restart_nova',
            'mesh_exec', 'deploy',
        ],
    },
    guest: {
        allowed: [
            'google_search', 'weather', 'translate', 'calculate',
        ],
        denied: ['*'], // Everything else denied
    },
    blocked: { allowed: [], denied: ['*'] },
}

export function isToolAllowed(userId: string, toolName: string): boolean {
    const perm = getUserPermission(userId)
    const rules = TOOL_PERMISSIONS[perm]

    if (!rules) return false

    // Check denied first
    if (rules.denied.includes('*') && !rules.allowed.includes(toolName)) return false
    if (rules.denied.includes(toolName)) return false

    // Check allowed
    if (rules.allowed === '*') return true
    return (rules.allowed as string[]).includes(toolName)
}

export function getToolsForUser(userId: string, allTools: string[]): string[] {
    return allTools.filter(t => isToolAllowed(userId, t))
}

export function getToolRestrictionMessage(userId: string, toolName: string): string {
    const perm = getUserPermission(userId)
    return `🔒 Tool "${toolName}" ist für deine Rolle (${perm}) nicht verfügbar. Frag einen Admin um Zugang.`
}

// ============================================
// 3. Per-User Memory Context
// ============================================

interface UserMemoryContext {
    userId: string
    facts: string[]        // Things Nova learned about this user
    preferences: string[]  // User preferences
    lastTopics: string[]   // Recent conversation topics
    updatedAt: number
}

const userMemory: Map<string, UserMemoryContext> = new Map()

export function getUserMemory(userId: string): UserMemoryContext {
    if (!userMemory.has(userId)) {
        // Try load from disk
        const path = join(DATA_DIR, 'memory', `${userId}.json`)
        if (existsSync(path)) {
            try {
                userMemory.set(userId, JSON.parse(readFileSync(path, 'utf-8')))
            } catch { }
        }
        if (!userMemory.has(userId)) {
            userMemory.set(userId, {
                userId,
                facts: [],
                preferences: [],
                lastTopics: [],
                updatedAt: Date.now(),
            })
        }
    }
    return userMemory.get(userId)!
}

export function addUserFact(userId: string, fact: string): void {
    const mem = getUserMemory(userId)
    if (!mem.facts.includes(fact)) {
        mem.facts.push(fact)
        if (mem.facts.length > 50) mem.facts = mem.facts.slice(-50)
        mem.updatedAt = Date.now()
        saveUserMemory(userId)
    }
}

export function addUserPreference(userId: string, pref: string): void {
    const mem = getUserMemory(userId)
    if (!mem.preferences.includes(pref)) {
        mem.preferences.push(pref)
        if (mem.preferences.length > 20) mem.preferences = mem.preferences.slice(-20)
        mem.updatedAt = Date.now()
        saveUserMemory(userId)
    }
}

export function addUserTopic(userId: string, topic: string): void {
    const mem = getUserMemory(userId)
    mem.lastTopics.push(topic)
    if (mem.lastTopics.length > 10) mem.lastTopics = mem.lastTopics.slice(-10)
    mem.updatedAt = Date.now()
    // Don't save on every topic (performance)
}

export function getUserContextString(userId: string): string {
    const mem = getUserMemory(userId)
    const user = users[userId]
    const lines: string[] = []

    if (user?.name) lines.push(`User: ${user.name}`)
    lines.push(`Rolle: ${user?.permission || 'guest'}`)
    if (mem.facts.length > 0) lines.push(`Bekannte Fakten: ${mem.facts.slice(-5).join('; ')}`)
    if (mem.preferences.length > 0) lines.push(`Präferenzen: ${mem.preferences.join('; ')}`)
    if (mem.lastTopics.length > 0) lines.push(`Letzte Themen: ${mem.lastTopics.slice(-3).join(', ')}`)

    return lines.join('\n')
}

function saveUserMemory(userId: string): void {
    try {
        const dir = join(DATA_DIR, 'memory')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const mem = userMemory.get(userId)
        if (mem) writeFileSync(join(dir, `${userId}.json`), JSON.stringify(mem, null, 2))
    } catch { }
}

// ============================================
// 4. Group Chat Support
// ============================================

interface GroupChat {
    chatId: string
    users: Map<string, { name?: string; lastMessage: number; messageCount: number }>
    lastActivity: number
}

const groupChats: Map<string, GroupChat> = new Map()

export function trackGroupMessage(chatId: string, userId: string, name?: string): GroupChat {
    if (!groupChats.has(chatId)) {
        groupChats.set(chatId, {
            chatId,
            users: new Map(),
            lastActivity: Date.now(),
        })
    }

    const group = groupChats.get(chatId)!
    const existing = group.users.get(userId) || { name, lastMessage: 0, messageCount: 0 }
    existing.lastMessage = Date.now()
    existing.messageCount++
    if (name) existing.name = name
    group.users.set(userId, existing)
    group.lastActivity = Date.now()

    return group
}

export function getGroupContext(chatId: string): string {
    const group = groupChats.get(chatId)
    if (!group) return ''

    const activeUsers = Array.from(group.users.entries())
        .filter(([_, u]) => Date.now() - u.lastMessage < 30 * 60 * 1000) // Active in last 30min
        .map(([id, u]) => {
            const perm = getUserPermission(id)
            return `${u.name || id} (${perm})`
        })

    if (activeUsers.length <= 1) return ''
    return `Aktive User im Chat: ${activeUsers.join(', ')}`
}

export function isGroupChat(chatId: string, userId: string): boolean {
    // In Telegram: chatId !== userId means group
    return chatId !== userId
}

// ============================================
// 5. Message Coalescing (Burst Detection)
// ============================================

interface MessageBuffer {
    userId: string
    chatId: string
    messages: { content: string; timestamp: number }[]
    timer: ReturnType<typeof setTimeout> | null
    resolve: ((merged: string) => void) | null
}

const messageBuffers: Map<string, MessageBuffer> = new Map()

const COALESCE_WINDOW_MS = 2500 // 2.5 seconds

export function shouldCoalesce(chatId: string, userId: string): boolean {
    const key = `${chatId}:${userId}`
    return messageBuffers.has(key)
}

export function coalesceMessage(
    chatId: string,
    userId: string,
    content: string,
): Promise<string> {
    const key = `${chatId}:${userId}`

    return new Promise((resolve) => {
        const existing = messageBuffers.get(key)

        if (existing) {
            // Add to existing buffer
            existing.messages.push({ content, timestamp: Date.now() })

            // Reset timer
            if (existing.timer) clearTimeout(existing.timer)
            existing.resolve = resolve

            existing.timer = setTimeout(() => {
                // Merge all buffered messages
                const merged = existing.messages.map(m => m.content).join('\n')
                const count = existing.messages.length
                messageBuffers.delete(key)

                console.log(`[Coalesce] Merged ${count} messages from ${userId}`)
                resolve(merged)
            }, COALESCE_WINDOW_MS)
        } else {
            // First message — start buffer
            const buffer: MessageBuffer = {
                userId,
                chatId,
                messages: [{ content, timestamp: Date.now() }],
                timer: null,
                resolve,
            }

            buffer.timer = setTimeout(() => {
                const merged = buffer.messages.map(m => m.content).join('\n')
                messageBuffers.delete(key)
                resolve(merged)
            }, COALESCE_WINDOW_MS)

            messageBuffers.set(key, buffer)
        }
    })
}

// ============================================
// 6. User Onboarding
// ============================================

export function getOnboardingMessage(user: UserRecord): string | null {
    if (user.onboarded) return null

    user.onboarded = true
    saveUsers()

    switch (user.permission) {
        case 'owner':
        case 'admin':
            return null // No onboarding for owners/admins

        case 'user':
            return `👋 Willkommen! Ich bin Nova, dein AI-Assistent.

Du hast **User**-Rechte. Das heißt:
✅ Chat, Suche, Übersetzung, Bilder
✅ Dateien lesen, Code durchsuchen
❌ Keine Systembefehle oder SSH

Schreib einfach los — ich helfe dir gerne!
Tippe /help für alle Befehle.`

        case 'guest':
            return `👋 Hallo! Ich bin Nova.

Du bist als **Gast** verbunden. Du kannst:
✅ Mit mir chatten
✅ Web-Suche, Wetter, Übersetzen
❌ Kein Dateizugriff, keine Befehle

Ein Admin kann deine Rechte erweitern.`

        default:
            return null
    }
}

// ============================================
// 7. Non-blocking Channel (Worker Pattern)
// ============================================

interface PendingTask {
    id: string
    userId: string
    chatId: string
    query: string
    status: 'queued' | 'running' | 'completed' | 'failed'
    startedAt: number
    completedAt?: number
    result?: string
}

const pendingTasks: Map<string, PendingTask> = new Map()
const HEAVY_TASK_PATTERNS = [
    /\/bot team/i,
    /analysiere|analyze/i,
    /recherchiere|research/i,
    /schreib.*code|write.*code|refactor/i,
    /deploy|backup|migration/i,
]

export function isHeavyTask(content: string): boolean {
    return HEAVY_TASK_PATTERNS.some(p => p.test(content))
}

export function createPendingTask(userId: string, chatId: string, query: string): PendingTask {
    const task: PendingTask = {
        id: `task_${Date.now().toString(36)}`,
        userId,
        chatId,
        query,
        status: 'queued',
        startedAt: Date.now(),
    }
    pendingTasks.set(task.id, task)
    return task
}

export function completePendingTask(taskId: string, result: string): void {
    const task = pendingTasks.get(taskId)
    if (task) {
        task.status = 'completed'
        task.completedAt = Date.now()
        task.result = result
        // Auto-cleanup after 5 min
        setTimeout(() => pendingTasks.delete(taskId), 5 * 60 * 1000)
    }
}

export function getPendingTasks(userId?: string): PendingTask[] {
    const all = Array.from(pendingTasks.values())
    return userId ? all.filter(t => t.userId === userId) : all
}

export function getHeavyTaskAck(query: string): string {
    return `⏳ Das wird einen Moment dauern — ich arbeite im Hintergrund daran.\n\n_"${query.slice(0, 60)}..."_\n\nDu kannst mir in der Zwischenzeit andere Fragen stellen.`
}

// ============================================
// Slash Commands for User Management
// ============================================

export function handleUserCommand(action: string, args: string, fromUser: string): string {
    const perm = getUserPermission(fromUser)

    switch (action) {
        case 'list':
        case 'ls': {
            if (perm !== 'owner' && perm !== 'admin') return '🔒 Nur Admins können User sehen.'
            const allUsers = listUsers()
            if (allUsers.length === 0) return '📭 Keine User registriert.'
            const list = allUsers.map(u => {
                const emoji = u.permission === 'owner' ? '👑' : u.permission === 'admin' ? '🛡️' : u.permission === 'user' ? '👤' : u.permission === 'guest' ? '👻' : '🚫'
                const msgs = u.messageCount
                const lastSeen = new Date(u.lastSeen).toLocaleDateString('de')
                return `${emoji} **${u.name || u.id}** — ${u.permission} (${msgs} msgs, zuletzt: ${lastSeen})`
            }).join('\n')
            return `👥 **User** (${allUsers.length})\n\n${list}`
        }

        case 'promote': {
            if (perm !== 'owner') return '🔒 Nur der Owner kann User befördern.'
            const parts = args.trim().split(/\s+/)
            const newRole = parts.pop()
            const targetRef = parts.join(' ')
            if (!targetRef || !newRole) return '❌ Syntax: /users promote <userId|name> <admin|user|guest>'
            if (!['admin', 'user', 'guest'].includes(newRole)) return '❌ Gültige Rollen: admin, user, guest'
            const target = resolveCurrentUser(targetRef)
            if (target.error) return `❌ ${target.error}`
            const success = setUserPermission(target.id, newRole as UserPermission)
            return success ? `✅ ${target.user.name || target.id} (\`${target.id}\`) → ${newRole}` : '❌ User konnte nicht aktualisiert werden.'
        }

        case 'block': {
            if (perm !== 'owner' && perm !== 'admin') return '🔒 Nur Admins können User blocken.'
            if (!args) return '❌ Syntax: /users block <userId|name>'
            const target = resolveCurrentUser(args)
            if (target.error) return `❌ ${target.error}`
            const success = setUserPermission(target.id, 'blocked')
            return success ? `🚫 ${target.user.name || target.id} (\`${target.id}\`) blockiert.` : '❌ User konnte nicht aktualisiert werden.'
        }

        case 'unblock': {
            if (perm !== 'owner' && perm !== 'admin') return '🔒 Nur Admins können User entblocken.'
            if (!args) return '❌ Syntax: /users unblock <userId|name>'
            const target = resolveCurrentUser(args)
            if (target.error) return `❌ ${target.error}`
            const success = setUserPermission(target.id, 'guest')
            return success ? `✅ ${target.user.name || target.id} (\`${target.id}\`) entblockt (als guest).` : '❌ User konnte nicht aktualisiert werden.'
        }

        case 'info': {
            const target = resolveCurrentUser(args.trim() || fromUser)
            if (target.error) return `❌ ${target.error}`
            if (perm !== 'owner' && perm !== 'admin' && target.id !== fromUser) return '🔒 Du kannst nur dein eigenes Profil anzeigen.'
            const user = target.user
            const mem = getUserMemory(target.id)
            return `👤 **${user.name || user.id}**

ID: \`${target.id}\`
Rolle: ${user.permission}
Channel: ${user.channel}
Messages: ${user.messageCount}
Erste Nachricht: ${new Date(user.firstSeen).toLocaleString('de')}
Letzte Aktivität: ${new Date(user.lastSeen).toLocaleString('de')}
Onboarded: ${user.onboarded ? 'Ja' : 'Nein'}
Fakten: ${mem.facts.length}
Präferenzen: ${mem.preferences.length}`
        }

        default:
            return `👥 **User-Verwaltung**

/users list — Alle User anzeigen
/users info <id|name> — User-Details
/users promote <id|name> <role> — Rolle ändern
/users block <id|name> — User blockieren
/users unblock <id|name> — User entblocken`
    }
}

// ============================================
// Init
// ============================================

export function initMultiUser(): void {
    loadUsers()
    console.log(`[MultiUser] ✅ Initialized: ${Object.keys(users).length} users`)
}
