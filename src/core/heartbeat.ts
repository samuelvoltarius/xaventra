/**
 * Heartbeat — Nova's Heartbeat System ❤️
 *
 * Reads .nova-data/heartbeat.md every X minutes (configurable).
 * Parses daily routines (HH:MM | Task) and fires them at the right time.
 * Uses the same wakeup pipeline as reminders to inject tasks into Nova.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Types
// ============================================

interface HeartbeatRoutine {
    hours: number
    minutes: number
    task: string
}

interface HeartbeatConfig {
    enabled: boolean
    intervalMinutes: number
}

// ============================================
// State
// ============================================

const HEARTBEAT_FILE = join(process.cwd(), '.nova-data', 'heartbeat.md')
const EXECUTION_LOG_FILE = join(process.cwd(), '.nova-data', 'heartbeat-log.json')

let config: HeartbeatConfig = { enabled: true, intervalMinutes: 5 }
let schedulerRunning = false

// Callback for sending messages to admin
let notifyCallback: ((message: string) => Promise<void>) | null = null
// Callback for waking Nova up (inject into pipeline)
let wakeupCallback: ((userId: string, channel: string, message: string) => Promise<void>) | null = null

// ============================================
// Config from xaventra.config.json
// ============================================

function loadConfig(): HeartbeatConfig {
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const data = JSON.parse(readFileSync(configPath, 'utf-8'))
            return {
                enabled: data.heartbeat?.enabled ?? true,
                intervalMinutes: data.heartbeat?.intervalMinutes ?? 5,
            }
        }
    } catch { /* default */ }
    return { enabled: true, intervalMinutes: 5 }
}

function saveConfigValue(key: string, value: unknown): void {
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const data = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (!data.heartbeat) data.heartbeat = {}
            data.heartbeat[key] = value
            writeFileSync(configPath, JSON.stringify(data, null, 2))
            console.log(`[Heartbeat] Config saved: ${key}=${value}`)
        }
    } catch (err) {
        console.error(`[Heartbeat] Config save failed: ${err}`)
    }
}

// ============================================
// Execution Log (prevents duplicate daily runs)
// ============================================

interface ExecutionEntry {
    task: string
    date: string  // YYYY-MM-DD
    time: string  // HH:MM
}

function loadExecutionLog(): ExecutionEntry[] {
    try {
        if (existsSync(EXECUTION_LOG_FILE)) {
            return JSON.parse(readFileSync(EXECUTION_LOG_FILE, 'utf-8'))
        }
    } catch { /* fresh */ }
    return []
}

function saveExecutionLog(log: ExecutionEntry[]): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        // Keep only last 7 days
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 7)
        const cutoffStr = cutoff.toISOString().split('T')[0]
        const trimmed = log.filter(e => e.date >= cutoffStr)
        writeFileSync(EXECUTION_LOG_FILE, JSON.stringify(trimmed, null, 2))
    } catch { /* non-critical */ }
}

function wasExecutedToday(task: string, time: string): boolean {
    const today = new Date().toISOString().split('T')[0]
    const log = loadExecutionLog()
    return log.some(e => e.task === task && e.date === today && e.time === time)
}

function markExecuted(task: string, time: string): void {
    const today = new Date().toISOString().split('T')[0]
    const log = loadExecutionLog()
    log.push({ task, date: today, time })
    saveExecutionLog(log)
}

// ============================================
// Parse heartbeat.md
// ============================================

function parseHeartbeat(): HeartbeatRoutine[] {
    if (!existsSync(HEARTBEAT_FILE)) return []

    try {
        const content = readFileSync(HEARTBEAT_FILE, 'utf-8')
        const lines = content.split('\n')
        const routines: HeartbeatRoutine[] = []

        for (const line of lines) {
            if (line.startsWith('#') || !line.trim()) continue

            // Parse: HH:MM | Task description
            const match = line.match(/^(\d{1,2}):(\d{2})\s*\|\s*(.+)/)
            if (match) {
                routines.push({
                    hours: parseInt(match[1]),
                    minutes: parseInt(match[2]),
                    task: match[3].trim(),
                })
            }
        }

        return routines
    } catch (err) {
        console.error(`[Heartbeat] Parse error: ${err}`)
        return []
    }
}

// ============================================
// Check & Execute
// ============================================

async function checkHeartbeat(): Promise<void> {
    if (!config.enabled) {
        console.log('[Heartbeat] Skipped: disabled in config')
        return
    }

    const routines = parseHeartbeat()
    if (routines.length === 0) {
        console.log('[Heartbeat] Skipped: no routines defined')
        return
    }

    const now = new Date()
    const currentHours = now.getHours()
    const currentMinutes = now.getMinutes()

    // Pulse log — show heartbeat is alive
    const currentMinutesOfDay = currentHours * 60 + currentMinutes
    const doneToday = routines.filter(r => {
        const timeKey = `${String(r.hours).padStart(2, '0')}:${String(r.minutes).padStart(2, '0')}`
        return wasExecutedToday(r.task, timeKey)
    }).length
    const nextRoutine = routines
        .filter(r => (r.hours * 60 + r.minutes) > currentMinutesOfDay)
        .sort((a, b) => (a.hours * 60 + a.minutes) - (b.hours * 60 + b.minutes))[0]
    const nextStr = nextRoutine
        ? `nächste: ${String(nextRoutine.hours).padStart(2, '0')}:${String(nextRoutine.minutes).padStart(2, '0')}`
        : 'alle für heute erledigt'
    console.log(`[Heartbeat] ❤️ Pulse — ${routines.length} Routinen, ${doneToday}/${routines.length} erledigt, ${nextStr}`)

    for (const routine of routines) {
        const routineMinutesOfDay = routine.hours * 60 + routine.minutes
        const diff = currentMinutesOfDay - routineMinutesOfDay

        // Fire if we're within 0 to intervalMinutes past the routine time
        if (diff >= 0 && diff < config.intervalMinutes) {
            const timeKey = `${String(routine.hours).padStart(2, '0')}:${String(routine.minutes).padStart(2, '0')}`

            if (wasExecutedToday(routine.task, timeKey)) continue

            console.log(`[Heartbeat] ❤️ Firing routine: ${timeKey} — ${routine.task.slice(0, 60)}...`)
            markExecuted(routine.task, timeKey)

            try {
                const { getAdminChatId } = await import('../tools/reminder-tool.js')
                const adminChatId = getAdminChatId()

                if (!adminChatId) {
                    console.log('[Heartbeat] ⚠ No admin chatId available — skipping')
                    continue
                }

                // Notify the user
                if (notifyCallback) {
                    await notifyCallback(`❤️ **Heartbeat Routine** (${timeKey})\n\n${routine.task}`)
                }

                // Wake Nova up — inject into message pipeline
                if (wakeupCallback) {
                    await wakeupCallback(
                        adminChatId,
                        'Telegram',
                        `[HEARTBEAT] Daily routine "${routine.task}" is due (${timeKey}). Execute this task now. Be proactive and thorough.`
                    )
                    console.log(`[Heartbeat] ✅ Wakeup sent: ${routine.task.slice(0, 50)}`)
                }
            } catch (err) {
                console.error(`[Heartbeat] Execution failed: ${err}`)
            }
        }
    }
}

// ============================================
// Scheduler Integration
// ============================================

export async function initHeartbeat(): Promise<void> {
    config = loadConfig()

    if (!config.enabled) {
        console.log('[Heartbeat] Disabled in config')
        return
    }

    // Ensure heartbeat.md exists
    if (!existsSync(HEARTBEAT_FILE)) {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(HEARTBEAT_FILE, `# Nova Heartbeat ❤️\n# Format: HH:MM | Task\n# Example:\n# 08:00 | Morning Briefing\n`)
        console.log('[Heartbeat] Created empty heartbeat.md')
    }

    // Register with CronerScheduler
    try {
        const { getCronerScheduler } = await import('./croner-scheduler.js')
        const scheduler = getCronerScheduler()

        const cronExpr = `0 */${config.intervalMinutes} * * * *`

        await scheduler.schedule(
            'heartbeat-checker',
            cronExpr,
            'Heartbeat Checker',
            async () => {
                await checkHeartbeat()
            }
        )

        schedulerRunning = true
        const routines = parseHeartbeat()
        console.log(`[Heartbeat] ❤️ Active: ${routines.length} routines, interval: every ${config.intervalMinutes} minutes`)
    } catch (err) {
        console.log(`[Heartbeat] Croner not available, using setInterval: ${err}`)
        setInterval(() => checkHeartbeat(), config.intervalMinutes * 60 * 1000)
        schedulerRunning = true
    }
}

// ============================================
// Callbacks
// ============================================

export function setHeartbeatNotifyCallback(cb: (message: string) => Promise<void>): void {
    notifyCallback = cb
}

export function setHeartbeatWakeupCallback(cb: (userId: string, channel: string, message: string) => Promise<void>): void {
    wakeupCallback = cb
}

// ============================================
// Slash Command Handler: /heartbeat
// ============================================

export function handleHeartbeatCommand(args: string): string {
    // /heartbeat — show status
    // /heartbeat 10 — set interval to 10 minutes
    // /heartbeat on/off — enable/disable
    // /heartbeat list — show routines

    if (!args || args === 'status') {
        const routines = parseHeartbeat()
        config = loadConfig()
        return `❤️ **Heartbeat Status**\n\n` +
            `• Active: ${config.enabled ? '✅ Yes' : '❌ No'}\n` +
            `• Interval: every ${config.intervalMinutes} minutes\n` +
            `• Routines: ${routines.length}\n\n` +
            routines.map(r => {
                const timeKey = `${String(r.hours).padStart(2, '0')}:${String(r.minutes).padStart(2, '0')}`
                const done = wasExecutedToday(r.task, timeKey) ? '✅' : '⏳'
                return `${done} ${timeKey} — ${r.task}`
            }).join('\n')
    }

    if (args === 'on') {
        config.enabled = true
        saveConfigValue('enabled', true)
        saveConfigValue('intervalMinutes', config.intervalMinutes)
        return '❤️ Heartbeat **enabled**'
    }

    if (args === 'off') {
        config.enabled = false
        saveConfigValue('enabled', false)
        return '💤 Heartbeat **disabled**'
    }

    if (args === 'list') {
        const routines = parseHeartbeat()
        if (routines.length === 0) return '📭 No routines in heartbeat.md'
        return `❤️ **Routines:**\n\n` + routines.map(r =>
            `• ${String(r.hours).padStart(2, '0')}:${String(r.minutes).padStart(2, '0')} — ${r.task}`
        ).join('\n')
    }

    // Number = set interval
    const num = parseInt(args)
    if (!isNaN(num) && num >= 1 && num <= 60) {
        config.intervalMinutes = num
        saveConfigValue('intervalMinutes', num)
        return `❤️ Heartbeat interval set to **${num} minutes** (saved to config)`
    }

    return '❤️ **Heartbeat Commands:**\n' +
        '• `/heartbeat` — Show status\n' +
        '• `/heartbeat list` — Show routines\n' +
        '• `/heartbeat 10` — Set interval to 10 min\n' +
        '• `/heartbeat on/off` — Enable/Disable'
}

export default {
    initHeartbeat,
    setHeartbeatNotifyCallback,
    setHeartbeatWakeupCallback,
    handleHeartbeatCommand,
}
