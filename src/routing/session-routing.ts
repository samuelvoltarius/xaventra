/**
 * Nova Session Routing
 * 
 * Inspired by OpenClaw's routing/ (6 files) and sessions/ (8 files)
 * Session management, route resolution, send-policy, model overrides.
 */

import { createHash } from 'node:crypto'

// ============================================
// Types
// ============================================

export interface Session {
    id: string
    channel: string
    userId: string
    context: string
    createdAt: number
    lastActivity: number
    messageCount: number
    modelOverride?: string
    metadata: Record<string, unknown>
}

export interface RouteConfig {
    channel: string
    pattern?: string
    agent?: string
    model?: string
    priority?: number
    rateLimitPerMinute?: number
}

export interface SendPolicy {
    maxPerMinute: number
    maxPerHour: number
    deduplicateMs: number
    cooldownMs: number
}

// ============================================
// Session Key Generation
// ============================================

export function generateSessionId(channel: string, userId: string, context = 'default'): string {
    const hash = createHash('sha256')
        .update(`${channel}:${userId}:${context}`)
        .digest('hex')
        .slice(0, 16)
    return `session_${hash}`
}

// ============================================
// Session Store
// ============================================

const sessions = new Map<string, Session>()

export function getSession(sessionId: string): Session | undefined {
    return sessions.get(sessionId)
}

export function getOrCreateSession(channel: string, userId: string, context = 'default'): Session {
    const id = generateSessionId(channel, userId, context)
    let session = sessions.get(id)
    if (!session) {
        session = {
            id,
            channel,
            userId,
            context,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            messageCount: 0,
            metadata: {},
        }
        sessions.set(id, session)
    }
    session.lastActivity = Date.now()
    session.messageCount++
    return session
}

export function updateSession(sessionId: string, updates: Partial<Session>): Session | undefined {
    const session = sessions.get(sessionId)
    if (!session) return undefined
    Object.assign(session, updates)
    return session
}

export function deleteSession(sessionId: string): boolean {
    return sessions.delete(sessionId)
}

export function listSessions(): Session[] {
    return [...sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity)
}

export function cleanExpiredSessions(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs
    let cleaned = 0
    for (const [id, session] of sessions) {
        if (session.lastActivity < cutoff) {
            sessions.delete(id)
            cleaned++
        }
    }
    return cleaned
}

// ============================================
// Route Resolution
// ============================================

const routes: RouteConfig[] = []

export function addRoute(config: RouteConfig): void {
    routes.push(config)
    routes.sort((a, b) => (b.priority || 0) - (a.priority || 0))
}

export function removeRoute(channel: string, pattern?: string): boolean {
    const idx = routes.findIndex(r => r.channel === channel && r.pattern === pattern)
    if (idx === -1) return false
    routes.splice(idx, 1)
    return true
}

export function resolveRoute(channel: string, message: string): RouteConfig | undefined {
    for (const route of routes) {
        if (route.channel !== channel && route.channel !== '*') continue
        if (route.pattern) {
            try {
                if (new RegExp(route.pattern).test(message)) return route
            } catch {
                if (message.includes(route.pattern)) return route
            }
        } else {
            return route
        }
    }
    return undefined
}

export function listRoutes(): RouteConfig[] {
    return [...routes]
}

// ============================================
// Model Override per Session
// ============================================

export function setModelOverride(sessionId: string, model: string): boolean {
    const session = sessions.get(sessionId)
    if (!session) return false
    session.modelOverride = model
    return true
}

export function clearModelOverride(sessionId: string): boolean {
    const session = sessions.get(sessionId)
    if (!session) return false
    delete session.modelOverride
    return true
}

export function getEffectiveModel(sessionId: string, defaultModel: string): string {
    const session = sessions.get(sessionId)
    return session?.modelOverride || defaultModel
}

// ============================================
// Send Policy (Rate Limiting)
// ============================================

const DEFAULT_POLICY: SendPolicy = {
    maxPerMinute: 30,
    maxPerHour: 500,
    deduplicateMs: 3000,
    cooldownMs: 500,
}

const sendHistory = new Map<string, number[]>()
const lastMessages = new Map<string, { text: string; time: number }>()

export function checkSendPolicy(
    sessionId: string,
    messageText: string,
    policy: Partial<SendPolicy> = {},
): { allowed: boolean; reason?: string } {
    const p = { ...DEFAULT_POLICY, ...policy }
    const now = Date.now()

    // Deduplicate
    const lastMsg = lastMessages.get(sessionId)
    if (lastMsg && lastMsg.text === messageText && now - lastMsg.time < p.deduplicateMs) {
        return { allowed: false, reason: 'duplicate message within dedup window' }
    }

    // Rate limit
    const history = sendHistory.get(sessionId) || []
    const recentMinute = history.filter(t => now - t < 60_000)
    if (recentMinute.length >= p.maxPerMinute) {
        return { allowed: false, reason: `rate limit exceeded: ${p.maxPerMinute}/min` }
    }

    const recentHour = history.filter(t => now - t < 3_600_000)
    if (recentHour.length >= p.maxPerHour) {
        return { allowed: false, reason: `rate limit exceeded: ${p.maxPerHour}/hour` }
    }

    // Cooldown
    if (history.length > 0 && now - history[history.length - 1]! < p.cooldownMs) {
        return { allowed: false, reason: `cooldown active: ${p.cooldownMs}ms` }
    }

    return { allowed: true }
}

export function recordSend(sessionId: string, messageText: string): void {
    const now = Date.now()
    const history = sendHistory.get(sessionId) || []
    history.push(now)
    // Keep last 1000
    if (history.length > 1000) history.splice(0, history.length - 1000)
    sendHistory.set(sessionId, history)
    lastMessages.set(sessionId, { text: messageText, time: now })
}

// ============================================
// Input Provenance Tracking
// ============================================

export interface InputProvenance {
    sessionId: string
    source: 'user' | 'system' | 'agent' | 'webhook' | 'cron'
    channel: string
    timestamp: number
    messageHash: string
}

const provenanceLog: InputProvenance[] = []

export function trackProvenance(entry: InputProvenance): void {
    provenanceLog.push(entry)
    if (provenanceLog.length > 5000) provenanceLog.splice(0, provenanceLog.length - 5000)
}

export function getProvenance(sessionId: string, limit = 20): InputProvenance[] {
    return provenanceLog.filter(p => p.sessionId === sessionId).slice(-limit)
}
