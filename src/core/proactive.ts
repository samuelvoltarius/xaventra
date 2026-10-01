/**
 * Xaventra Proactive Messaging — only the transport (2.82.0 Aufräumen).
 *
 * Alarms and system messages are thoughts (planner: importance rules, one
 * dedupe, the one quiet-hours definition in core/quiet-hours.ts, daily cap).
 * This messenger only carries what still goes out directly (sub-agent results,
 * reminders, and the governed path while the planner is switched off) to the
 * registered channels, fenced per message. It reads the same quiet hours; the
 * former helpers sendAlarm/sendReminder/sendError/sendReport were never called
 * and are gone.
 */

import { evaluateProactivity, type ProactiveAssessment } from './proactive-policy.js'
import { isFenceError } from '../mesh/fence.js'
import { getQuietHours, isQuietHourOfDay } from './quiet-hours.js'

// ============================================
// Types
// ============================================

export interface ProactiveMessage {
    userId: string
    channel: 'telegram' | 'whatsapp' | 'discord' | 'all'
    content: string
    priority: 'low' | 'normal' | 'high' | 'urgent'
    type: 'alarm' | 'reminder' | 'error' | 'notification' | 'report'
    assessment?: ProactiveAssessment
}

export interface ChannelSender {
    name: string
    isConnected: () => boolean
    send: (userId: string, content: string) => Promise<boolean>
}

export interface ProactivePolicy {
    dailyBudget: number
    quietHoursStart: number
    quietHoursEnd: number
    dedupeWindowMs: number
    maxQueueSize: number
}

// ============================================
// Proactive Messenger
// ============================================

export class ProactiveMessenger {
    private channels: Map<string, ChannelSender> = new Map()
    private queue: ProactiveMessage[] = []
    private processing = false
    private sentToday = 0
    private budgetDate = new Date().toISOString().slice(0, 10)
    private recent = new Map<string, number>()
    private policy: ProactivePolicy
    /** Explicit quiet hours from the constructor (tests, benchmarks); otherwise the one definition. */
    private readonly ownQuietHours: boolean

    constructor(policy: Partial<ProactivePolicy> = {}) {
        this.ownQuietHours = policy.quietHoursStart !== undefined || policy.quietHoursEnd !== undefined
        this.policy = {
            dailyBudget: 20,
            quietHoursStart: getQuietHours().start,
            quietHoursEnd: getQuietHours().end,
            dedupeWindowMs: 30 * 60 * 1000,
            maxQueueSize: 100,
            ...policy,
        }
        console.log('[ProactiveMessenger] Initialized')
    }

    /** 'defer': quiet hours or daily budget – keep the message and deliver it
     * later instead of dropping it silently (R2 NZ-12). 'duplicate': already
     * delivered within the dedupe window. */
    private canSend(msg: ProactiveMessage): 'ok' | 'defer' | 'duplicate' {
        const today = new Date().toISOString().slice(0, 10)
        if (today !== this.budgetDate) {
            this.budgetDate = today
            this.sentToday = 0
        }
        const key = `${msg.userId}:${msg.channel}:${msg.type}:${msg.assessment?.dedupeKey || msg.content}`
        const lastSent = this.recent.get(key) ?? 0
        if (Date.now() - lastSent < this.policy.dedupeWindowMs) return 'duplicate'
        // A user-requested alarm (Wecker) is due exactly now: quiet hours and
        // budget must not swallow it.
        if (msg.priority !== 'urgent' && msg.type !== 'alarm') {
            if (this.sentToday >= this.policy.dailyBudget) return 'defer'
            const hour = new Date().getHours()
            const window = this.ownQuietHours ? { start: this.policy.quietHoursStart, end: this.policy.quietHoursEnd } : getQuietHours()
            if (isQuietHourOfDay(hour, window)) return 'defer'
        }
        return 'ok'
    }

    private enqueue(msg: ProactiveMessage): void {
        if (this.queue.length >= this.policy.maxQueueSize) this.queue.shift()
        this.queue.push(msg)
    }

    /**
     * Register a channel for proactive messaging
     */
    registerChannel(channel: ChannelSender): void {
        this.channels.set(channel.name, channel)
        console.log(`[ProactiveMessenger] Registered channel: ${channel.name}`)
    }

    /**
     * Send a proactive message to a user
     */
    async send(msg: ProactiveMessage): Promise<boolean> {
        const outcome = await this.attempt(msg)
        if (outcome === 'deferred') this.enqueue(msg)
        return outcome === 'sent'
    }

    private markSent(msg: ProactiveMessage): void {
        this.sentToday++
        this.recent.set(`${msg.userId}:${msg.channel}:${msg.type}:${msg.assessment?.dedupeKey || msg.content}`, Date.now())
    }

    /** alreadyApproved: queued messages passed the evidence policy when they
     * were deferred; their 15-minute evidence window must not expire them
     * while they wait for quiet hours to end or a channel to reconnect. */
    private async attempt(msg: ProactiveMessage, alreadyApproved = false): Promise<'sent' | 'deferred' | 'dropped'> {
        if (!msg.assessment) {
            console.log('[ProactiveMessenger] Suppressed: no typed evidence assessment')
            return 'dropped'
        }
        const decision = alreadyApproved ? { allow: true, reason: 'approved before deferral' } : evaluateProactivity(msg.assessment)
        if (!decision.allow) {
            console.log(`[ProactiveMessenger] Suppressed: ${decision.reason}`)
            return 'dropped'
        }
        const gate = this.canSend(msg)
        if (gate === 'duplicate') return 'dropped'
        if (gate === 'defer') {
            console.log(`[ProactiveMessenger] Deferred ${msg.type} for ${msg.userId} (quiet hours or daily budget)`)
            return 'deferred'
        }
        console.log(`[ProactiveMessenger] Sending ${msg.type} to ${msg.userId} via ${msg.channel}`)

        if (msg.channel === 'all') {
            // Send to all connected channels
            let success = false
            let anyConnected = false
            let fenced = false
            for (const [name, sender] of this.channels) {
                if (sender.isConnected()) {
                    anyConnected = true
                    try {
                        // false = not delivered (e.g. no leadership): not a success (R2 NZ-13).
                        if (await sender.send(msg.userId, msg.content) === true) {
                            success = true
                            console.log(`[ProactiveMessenger] ✅ Sent via ${name}`)
                        } else {
                            console.log(`[ProactiveMessenger] ⚠️ Not delivered via ${name}`)
                        }
                    } catch (err) {
                        // CL-07: fenced is not failed; keep it for a later attempt.
                        if (isFenceError(err)) fenced = true
                        console.log(`[ProactiveMessenger] ⚠️ Failed on ${name}: ${err}`)
                    }
                }
            }
            if (success) this.markSent(msg)
            // Nothing connected or fenced: keep for later. Connected but refused: drop.
            return success ? 'sent' : anyConnected && !fenced ? 'dropped' : 'deferred'
        }

        // Send to specific channel
        const sender = this.channels.get(msg.channel)
        if (!sender) {
            console.log(`[ProactiveMessenger] ❌ Channel ${msg.channel} not registered`)
            return 'dropped'
        }

        if (!sender.isConnected()) {
            console.log(`[ProactiveMessenger] ❌ Channel ${msg.channel} not connected`)
            return 'deferred'
        }

        try {
            // false = not delivered (e.g. no Main/Telegram leadership during a
            // failover). It must neither count nor block the retry (R2 NZ-13).
            if (await sender.send(msg.userId, msg.content) !== true) {
                console.log(`[ProactiveMessenger] ❌ Not delivered via ${msg.channel}`)
                return 'dropped'
            }
            this.markSent(msg)
            return 'sent'
        } catch (err) {
            if (isFenceError(err)) {
                console.log(`[ProactiveMessenger] Deferred ${msg.type} for ${msg.userId}: ${err}`)
                return 'deferred'
            }
            console.log(`[ProactiveMessenger] ❌ Send failed: ${err}`)
            return 'dropped'
        }
    }

    /**
     * Process queued messages (call periodically)
     */
    async processQueue(): Promise<number> {
        if (this.processing || this.queue.length === 0) return 0

        this.processing = true
        let sent = 0

        const remaining: ProactiveMessage[] = []
        const batch = this.queue
        this.queue = []
        try {
            for (const msg of batch) {
                const outcome = await this.attempt(msg, true)
                if (outcome === 'sent') sent++
                else if (outcome === 'deferred') remaining.push(msg)
            }
        } finally {
            // Messages deferred by send() while this batch ran are kept as well.
            this.queue = [...remaining, ...this.queue].slice(-this.policy.maxQueueSize)
            this.processing = false
        }
        return sent
    }

    /**
     * Get stats
     */
    getStats(): { channels: string[]; queueLength: number; sentToday: number; dailyBudget: number } {
        return {
            channels: Array.from(this.channels.keys()),
            queueLength: this.queue.length,
            sentToday: this.sentToday,
            dailyBudget: this.policy.dailyBudget,
        }
    }
}

// ============================================
// Singleton
// ============================================

let instance: ProactiveMessenger | null = null

export function getProactiveMessenger(): ProactiveMessenger {
    if (!instance) {
        instance = new ProactiveMessenger()
    }
    return instance
}

export default { ProactiveMessenger, getProactiveMessenger }
