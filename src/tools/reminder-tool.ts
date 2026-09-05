/**
 * Reminder Tool v2 — Persistent, Restart-Safe
 * 
 * Uses disk persistence + interval checker instead of volatile setTimeout.
 * Reminders survive restarts. Supports both minute-delays AND clock times.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface StoredReminder {
    id: string
    message: string
    triggerAt: number      // Unix timestamp
    userId: string
    channel: string
    createdAt: number
    fired: boolean
}

const REMINDERS_FILE = join(process.cwd(), '.nova-data', 'reminders.json')
let reminders: StoredReminder[] = []
let checkerInterval: ReturnType<typeof setInterval> | null = null

// Callback for sending reminder notifications
let notifyCallback: ((userId: string, channel: string, message: string) => Promise<void>) | null = null
// Callback for waking Nova up — injects the reminder into the message pipeline
let wakeupCallback: ((userId: string, channel: string, message: string) => Promise<void>) | null = null

export function setReminderNotifyCallback(callback: (userId: string, channel: string, message: string) => Promise<void>) {
    notifyCallback = callback
}

export function setReminderWakeupCallback(callback: (userId: string, channel: string, message: string) => Promise<void>) {
    wakeupCallback = callback
}

// ============================================
// Persistence
// ============================================

function loadReminders(): StoredReminder[] {
    try {
        if (existsSync(REMINDERS_FILE)) {
            const data = JSON.parse(readFileSync(REMINDERS_FILE, 'utf-8'))
            return Array.isArray(data) ? data.filter((r: StoredReminder) => !r.fired) : []
        }
    } catch { /* fresh start */ }
    return []
}

function saveReminders(): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2))
    } catch (err) {
        console.error(`[Reminder] Save failed: ${err}`)
    }
}

// ============================================
// Checker — runs every 30 seconds via CronerScheduler
// ============================================

async function startChecker(): Promise<void> {
    if (checkerInterval) return

    // Try croner first — more reliable than setInterval
    try {
        const { getCronerScheduler } = await import('../core/croner-scheduler.js')
        const scheduler = getCronerScheduler()

        await scheduler.schedule(
            'reminder-checker',
            '*/30 * * * * *',  // Every 30 seconds
            'Reminder Checker',
            async () => {
                await checkAndFireReminders()
            }
        )
        checkerInterval = true as any  // Mark as running
        console.log('[Reminder] \u2705 Using CronerScheduler (cron-based, reliable)')
        return
    } catch {
        // Fallback to setInterval if croner not available
        console.log('[Reminder] \u26a0\ufe0f Croner not available, falling back to setInterval')
    }

    // Fallback: setInterval
    checkerInterval = setInterval(async () => {
        await checkAndFireReminders()
    }, 30_000)
}

async function checkAndFireReminders(): Promise<void> {
    const now = Date.now()
    const due = reminders.filter(r => !r.fired && r.triggerAt <= now)

    for (const reminder of due) {
        reminder.fired = true
        console.log(`[Reminder] \u23f0 Firing: ${reminder.message} (for ${reminder.userId})`)

        // Step 1: Send notification to user (chat message)
        if (notifyCallback) {
            try {
                await notifyCallback(
                    reminder.userId,
                    reminder.channel,
                    `\u23f0 **Erinnerung!**\n\n${reminder.message}`
                )
            } catch (err) {
                console.error(`[Reminder] Notify failed: ${err}`)
            }
        }

        // Step 2: Wake Nova up — inject reminder as pipeline message so she acts on it
        if (wakeupCallback) {
            try {
                await wakeupCallback(
                    reminder.userId,
                    reminder.channel,
                    `[REMINDER] Die Erinnerung "${reminder.message}" hat gerade getriggert. Reagiere darauf und arbeite weiter an den anstehenden Aufgaben. Prüfe mit /mission status ob es offene Missionen gibt.`
                )
                console.log(`[Reminder] \u2705 Pipeline wakeup sent for: ${reminder.message.slice(0, 50)}`)
            } catch (err) {
                console.error(`[Reminder] Wakeup failed: ${err}`)
            }
        }
    }

    if (due.length > 0) {
        // Remove fired reminders
        reminders = reminders.filter(r => !r.fired)
        saveReminders()
    }
}

/**
 * Get admin chat ID dynamically (no hardcoding!)
 * Resolves from: config.allowFrom > lastActiveChat > globalState
 */
export function getAdminChatId(): string | undefined {
    const globalState = (globalThis as any).__novaState
    const tgConfig = globalState?.config?.channels?.telegram
    return tgConfig?.allowFrom?.[0] || globalState?.lastActiveChatId || undefined
}

// ============================================
// Initialize — called on startup
// ============================================

export async function initReminders(): Promise<void> {
    reminders = loadReminders()
    const pending = reminders.filter(r => !r.fired && r.triggerAt > Date.now())
    const overdue = reminders.filter(r => !r.fired && r.triggerAt <= Date.now())

    console.log(`[Reminder] Loaded ${pending.length} pending, ${overdue.length} overdue reminders`)

    await startChecker()

    // Fire overdue reminders immediately (missed during downtime)
    if (overdue.length > 0) {
        console.log(`[Reminder] ⚠️ Firing ${overdue.length} overdue reminders...`)
        // They'll be caught by the next checker tick (within 30s)
    }
}

// ============================================
// Parse time expressions
// ============================================

function parseTimeExpression(input: string | number, minutesParam?: number): number {
    // If minutes given directly
    if (typeof minutesParam === 'number' && minutesParam > 0) {
        return Date.now() + (minutesParam * 60 * 1000)
    }

    if (typeof input === 'number') {
        return Date.now() + (input * 60 * 1000)
    }

    // Try clock time patterns: "10:00", "10 Uhr", "14:30"
    const clockMatch = input.match(/(\d{1,2}):(\d{2})/)
    if (clockMatch) {
        const hours = parseInt(clockMatch[1])
        const mins = parseInt(clockMatch[2])
        const now = new Date()
        const target = new Date(now)
        target.setHours(hours, mins, 0, 0)

        // If time already passed today, schedule for tomorrow
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1)
        }
        return target.getTime()
    }

    // "10 Uhr" pattern
    const uhrMatch = input.match(/(\d{1,2})\s*[Uu]hr/)
    if (uhrMatch) {
        const hours = parseInt(uhrMatch[1])
        const now = new Date()
        const target = new Date(now)
        target.setHours(hours, 0, 0, 0)
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1)
        }
        return target.getTime()
    }

    // "in X minuten/stunden" pattern
    const delayMatch = input.match(/(\d+)\s*(min|stunde|hour|h)/i)
    if (delayMatch) {
        const val = parseInt(delayMatch[1])
        const unit = delayMatch[2].toLowerCase()
        const multiplier = (unit === 'min') ? 1 : 60
        return Date.now() + (val * multiplier * 60 * 1000)
    }

    // "morgen um HH:MM" pattern
    const morgenMatch = input.match(/morgen.*?(\d{1,2}):?(\d{2})?/i)
    if (morgenMatch) {
        const hours = parseInt(morgenMatch[1])
        const mins = morgenMatch[2] ? parseInt(morgenMatch[2]) : 0
        const target = new Date()
        target.setDate(target.getDate() + 1)
        target.setHours(hours, mins, 0, 0)
        return target.getTime()
    }

    // Default: treat as minutes
    const numVal = parseFloat(input)
    if (!isNaN(numVal) && numVal > 0) {
        return Date.now() + (numVal * 60 * 1000)
    }

    return 0 // Invalid
}

// ============================================
// Tool Definitions
// ============================================

export const reminderTool = {
    name: 'set_reminder',
    description: 'Setze eine Erinnerung. Unterstützt Uhrzeiten ("10:00", "14:30"), relative Zeiten ("in 30 min"), und natürliche Sprache ("morgen um 10"). Überlebt Restarts!',
    category: 'system' as const,
    parameters: [
        { name: 'message', type: 'string' as const, description: 'Die Erinnerungsnachricht', required: true },
        { name: 'time', type: 'string' as const, description: 'Wann erinnern: "10:00", "14:30", "in 30 min", "morgen um 10"', required: true },
        { name: 'minutes', type: 'number' as const, description: 'Alternative: in wie vielen Minuten (deprecated, nutze time)', required: false },
        { name: 'userId', type: 'string' as const, description: 'User ID (automatisch gesetzt)', required: false },
        { name: 'channel', type: 'string' as const, description: 'Channel (automatisch gesetzt)', required: false },
    ],
    handler: async (params: Record<string, unknown>, context?: { userId?: string; channel?: string }) => {
        const message = params.message as string
        const timeInput = params.time as string || ''
        const minutes = params.minutes as number | undefined

        if (!message?.trim()) {
            return { success: false, error: 'Nachricht erforderlich' }
        }

        const triggerAt = parseTimeExpression(timeInput, minutes)
        if (triggerAt <= 0) {
            return { success: false, error: 'Ungültige Zeitangabe. Beispiele: "10:00", "in 30 min", "morgen um 8"' }
        }

        const userId = (params.userId as string) || context?.userId || 'unknown'
        const channel = (params.channel as string) || context?.channel || 'Telegram'

        const id = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const triggerDate = new Date(triggerAt)
        const triggerTimeStr = triggerDate.toLocaleString('de-DE', {
            day: '2-digit', month: '2-digit',
            hour: '2-digit', minute: '2-digit'
        })

        const reminder: StoredReminder = {
            id,
            message: message.trim(),
            triggerAt,
            userId,
            channel,
            createdAt: Date.now(),
            fired: false,
        }

        reminders.push(reminder)
        saveReminders()
        await startChecker() // Ensure checker is running

        const deltaMinutes = Math.round((triggerAt - Date.now()) / 60000)

        console.log(`[Reminder] ✅ Set for ${userId}: "${message}" at ${triggerTimeStr} (in ${deltaMinutes} min)`)

        return {
            success: true,
            message: `✅ Erinnerung gesetzt für **${triggerTimeStr}** (in ~${deltaMinutes} Minuten)\n\n📝 ${message.trim()}`,
            triggerAt: triggerTimeStr,
            minutesUntil: deltaMinutes,
        }
    },
}

export const listRemindersTool = {
    name: 'list_reminders',
    description: 'Zeige alle aktiven Erinnerungen',
    category: 'system' as const,
    parameters: [],
    handler: async () => {
        const pending = reminders.filter(r => !r.fired)

        if (pending.length === 0) {
            return { count: 0, message: '📭 Keine aktiven Erinnerungen.', reminders: [] }
        }

        const list = pending.map(r => ({
            message: r.message,
            triggerAt: new Date(r.triggerAt).toLocaleString('de-DE', {
                day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit'
            }),
            userId: r.userId,
            minutesLeft: Math.round((r.triggerAt - Date.now()) / 60000),
        }))

        return {
            count: pending.length,
            reminders: list,
        }
    },
}

export default { reminderTool, listRemindersTool, setReminderNotifyCallback, setReminderWakeupCallback, initReminders, getAdminChatId }
