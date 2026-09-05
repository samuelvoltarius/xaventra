/**
 * Nova Autonomy Loop — Check-Evaluate-Act Engine
 * 
 * Nova's autonomous background process that:
 * 1. CHECK: Gathers system status, health, pending tasks
 * 2. EVALUATE: Analyzes findings, decides what's important
 * 3. ACT: Takes action or notifies the user
 * 
 * Uses CronerScheduler for reliable cron-based execution.
 * Sends proactive messages via ProactiveMessenger.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hasGlobalAutonomyAuthority } from './autonomy-authority.js'

// ============================================
// Types
// ============================================

export interface AutonomyConfig {
    enabled: boolean
    intervalMinutes: number          // How often the loop runs (default: 10)
    quietHoursStart: number          // Don't disturb after this hour (default: 23)
    quietHoursEnd: number            // Don't disturb before this hour (default: 7)
    maxNotificationsPerHour: number  // Rate limit (default: 3)
    socialCheckIns: boolean          // Greetings/follow-ups are opt-in
    checks: {
        health: boolean              // System health (disk, memory)
        reminders: boolean           // Pending reminders
        inbound: boolean             // Watch inbound folders
        logs: boolean                // Error log scanning
        uptime: boolean              // Process uptime tracking
    }
}

export interface CheckResult {
    source: string
    severity: 'info' | 'warning' | 'critical'
    message: string
    timestamp: number
    actionTaken?: string
    requiresNotification: boolean
}

export interface AutonomyReport {
    timestamp: number
    checks: CheckResult[]
    summary: string
    notificationSent: boolean
}

// ============================================
// State
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const AUTONOMY_LOG = join(DATA_DIR, 'autonomy-log.json')
const DEFAULT_CONFIG: AutonomyConfig = {
    enabled: true,
    intervalMinutes: 10,
    quietHoursStart: 23,
    quietHoursEnd: 7,
    maxNotificationsPerHour: 3,
    socialCheckIns: false,
    checks: {
        health: true,
        reminders: true,
        inbound: true,
        logs: true,
        uptime: true,
    },
}

let config: AutonomyConfig = { ...DEFAULT_CONFIG }
let running = false
let lastReport: AutonomyReport | null = null
let notificationCount = 0
let lastNotificationReset = Date.now()
let sendNotification: ((message: string) => Promise<void>) | null = null
let lastImportantFingerprint = ''
let lastImportantNotificationAt = 0
const IMPORTANT_REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000

// Self-Thinking: inject pipeline messages for proactive behavior
let thinkFn: ((selfPrompt: string) => Promise<string>) | null = null
let selfThinkCount = 0
let lastSelfThinkReset = Date.now()
const MAX_SELF_THINKS_PER_HOUR = 4
const MIN_IDLE_MINUTES = 3
const MIN_SELF_THINK_INTERVAL_MINUTES = 8
const DAILY_FLAGS_FILE = join(DATA_DIR, 'autonomy-daily.json')

const SOCIAL_TRIGGER_TYPES = new Set([
    'morning', 'evening', 'follow-up', 'idle-checkin', 'user-pattern',
    'unfinished-topic', 'learning', 'spontaneous',
])

/**
 * Operational alerts already have deterministic, evidence-aware producers
 * (HealthMonitor, reminder scheduler and L15). Sending them through the LLM a
 * second time caused duplicate Telegram cards and expensive tool retries.
 */
export function selectAgentTriggers<T extends { type: string }>(triggers: T[], socialCheckIns: boolean, enabledTypes?: ReadonlySet<string>): T[] {
    return triggers.filter(trigger => {
        if (enabledTypes && !enabledTypes.has(trigger.type)) return false
        return trigger.type === 'mission' || (socialCheckIns && SOCIAL_TRIGGER_TYPES.has(trigger.type))
    })
}

// ============================================
// Check Functions (Phase 1: CHECK)
// ============================================

async function checkSystemHealth(): Promise<CheckResult[]> {
    const results: CheckResult[] = []

    try {
        const { runHealthCheck } = await import('../layers/L0-health-monitor.js')
        const health = runHealthCheck()

        if (!health.healthy) {
            for (const warning of health.warnings) {
                results.push({
                    source: 'health',
                    severity: 'warning',
                    message: warning,
                    timestamp: Date.now(),
                    // L0 Health owns the single transition notification. The
                    // autonomy report may observe the condition, but must not
                    // emit a second Telegram message for the same evidence.
                    requiresNotification: false,
                })
            }
        } else {
            results.push({
                source: 'health',
                severity: 'info',
                message: `System OK — Disk: ${health.disk.freeGB}GB frei, RAM: ${health.memory.usedPercent}%`,
                timestamp: Date.now(),
                requiresNotification: false,
            })
        }
    } catch (err) {
        results.push({
            source: 'health',
            severity: 'info',
            message: `Health-Check nicht verfügbar: ${err}`,
            timestamp: Date.now(),
            requiresNotification: false,
        })
    }

    return results
}

async function checkPendingReminders(): Promise<CheckResult[]> {
    const results: CheckResult[] = []

    try {
        const remindersFile = join(DATA_DIR, 'reminders.json')
        if (existsSync(remindersFile)) {
            const data = JSON.parse(readFileSync(remindersFile, 'utf-8'))
            const pending = Array.isArray(data) ? data.filter((r: any) => !r.fired) : []
            const overdue = pending.filter((r: any) => r.triggerAt <= Date.now())

            if (overdue.length > 0) {
                results.push({
                    source: 'reminders',
                    severity: 'warning',
                    message: `${overdue.length} überfällige Erinnerung(en)!`,
                    timestamp: Date.now(),
                    requiresNotification: true,
                })
            }

            if (pending.length > 0) {
                const next = pending
                    .filter((r: any) => r.triggerAt > Date.now())
                    .sort((a: any, b: any) => a.triggerAt - b.triggerAt)[0]

                if (next) {
                    const minutesUntil = Math.round((next.triggerAt - Date.now()) / 60000)
                    results.push({
                        source: 'reminders',
                        severity: 'info',
                        message: `Nächste Erinnerung in ${minutesUntil}min: "${next.message}"`,
                        timestamp: Date.now(),
                        requiresNotification: false,
                    })
                }
            }
        }
    } catch { /* non-critical */ }

    return results
}

async function checkInboundFolders(): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    const watchDirs = [
        join(process.cwd(), 'inbound'),
        join(process.cwd(), '.nova-data', 'inbound'),
    ]

    for (const dir of watchDirs) {
        try {
            if (existsSync(dir)) {
                const files = readdirSync(dir)
                if (files.length > 0) {
                    results.push({
                        source: 'inbound',
                        severity: 'info',
                        message: `${files.length} Datei(en) in ${dir}`,
                        timestamp: Date.now(),
                        requiresNotification: files.length > 5, // Notify if many files
                    })
                }
            }
        } catch { /* skip */ }
    }

    return results
}

async function checkErrorLogs(): Promise<CheckResult[]> {
    const results: CheckResult[] = []

    try {
        const logFile = join(DATA_DIR, 'error-log.json')
        if (existsSync(logFile)) {
            const stat = statSync(logFile)
            const ageMs = Date.now() - stat.mtimeMs

            // Only check recent errors (last hour)
            if (ageMs < 3600000) {
                const data = JSON.parse(readFileSync(logFile, 'utf-8'))
                const recentErrors = Array.isArray(data)
                    ? data.filter((e: any) => Date.now() - (e.timestamp || 0) < 3600000)
                    : []

                if (recentErrors.length > 0) {
                    results.push({
                        source: 'logs',
                        severity: recentErrors.length > 5 ? 'critical' : 'warning',
                        message: `${recentErrors.length} Fehler in der letzten Stunde`,
                        timestamp: Date.now(),
                        requiresNotification: recentErrors.length > 3,
                    })
                }
            }
        }
    } catch { /* non-critical */ }

    return results
}

async function checkUptime(): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    const globalState = (globalThis as any).__novaState

    if (globalState?.startTime) {
        const uptimeMs = Date.now() - globalState.startTime
        const uptimeHours = Math.round(uptimeMs / 3600000 * 10) / 10

        results.push({
            source: 'uptime',
            severity: 'info',
            message: `Nova läuft seit ${uptimeHours}h`,
            timestamp: Date.now(),
            requiresNotification: false,
        })

        // Uptime alone is not a fault. Restarts are recommended only by a
        // concrete health signal (memory leak, stale runtime, failed probe).
    }

    return results
}

// ============================================
// Evaluate (Phase 2: EVALUATE)
// ============================================

function evaluate(checks: CheckResult[]): { shouldNotify: boolean; summary: string; important: CheckResult[] } {
    const now = new Date()
    const hour = now.getHours()

    // Quiet hours check
    const inQuietHours = config.quietHoursStart > config.quietHoursEnd
        ? (hour >= config.quietHoursStart || hour < config.quietHoursEnd)
        : (hour >= config.quietHoursStart && hour < config.quietHoursEnd)

    // Rate limiting
    if (Date.now() - lastNotificationReset > 3600000) {
        notificationCount = 0
        lastNotificationReset = Date.now()
    }

    const important = checks.filter(c => c.requiresNotification)
    const critical = checks.filter(c => c.severity === 'critical')
    const warnings = checks.filter(c => c.severity === 'warning')

    // Build summary
    const parts: string[] = []
    if (critical.length > 0) parts.push(`🚨 ${critical.length} kritisch`)
    if (warnings.length > 0) parts.push(`⚠️ ${warnings.length} Warnung(en)`)

    const okCount = checks.filter(c => c.severity === 'info').length
    if (okCount > 0 && critical.length === 0 && warnings.length === 0) {
        parts.push(`✅ ${okCount} Check(s) OK`)
    }

    const summary = parts.join(' | ') || '✅ Alles im grünen Bereich'

    // Decision: Should we notify?
    let shouldNotify = false

    // Critical always notifies (even during quiet hours)
    if (critical.length > 0) {
        shouldNotify = true
    }
    // Warnings notify outside quiet hours
    else if (important.length > 0 && !inQuietHours) {
        shouldNotify = notificationCount < config.maxNotificationsPerHour
    }

    if (shouldNotify) {
        const fingerprint = important
            .map(item => `${item.source}:${item.severity}:${item.message.replace(/\d+(?:[.,]\d+)?/g, '#')}`)
            .sort()
            .join('|')
        if (fingerprint === lastImportantFingerprint
            && Date.now() - lastImportantNotificationAt < IMPORTANT_REMINDER_INTERVAL_MS) {
            shouldNotify = false
        }
    }

    return { shouldNotify, summary, important }
}

// ============================================
// Act (Phase 3: ACT)
// ============================================

async function act(evaluation: { shouldNotify: boolean; summary: string; important: CheckResult[] }, allChecks: CheckResult[]): Promise<AutonomyReport> {
    const report: AutonomyReport = {
        timestamp: Date.now(),
        checks: allChecks,
        summary: evaluation.summary,
        notificationSent: false,
    }

    if (evaluation.shouldNotify && sendNotification) {
        const now = new Date()
        const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

        let msg = `🤖 *Nova Autonomy Report* (${timeStr})\n\n`
        msg += `${evaluation.summary}\n\n`

        for (const check of evaluation.important) {
            const icon = check.severity === 'critical' ? '🚨' : '⚠️'
            msg += `${icon} *${check.source}:* ${check.message}\n`
            if (check.actionTaken) {
                msg += `  ↳ Aktion: ${check.actionTaken}\n`
            }
        }

        msg += `\n_Status: Ich bleibe im Hintergrund wach. 🌙✨_`

        try {
            await sendNotification(msg)
            report.notificationSent = true
            notificationCount++
            lastImportantFingerprint = evaluation.important
                .map(item => `${item.source}:${item.severity}:${item.message.replace(/\d+(?:[.,]\d+)?/g, '#')}`)
                .sort()
                .join('|')
            lastImportantNotificationAt = Date.now()
            console.log(`[Autonomy] 📣 Notification sent (${notificationCount} this hour)`)
        } catch (err) {
            console.error(`[Autonomy] ❌ Notification failed: ${err}`)
        }
    }

    // ============================================
    // Phase 3b: SELF-THINK — Inject into pipeline if pending work
    // ============================================
    if (thinkFn) {
        await trySelfThink(allChecks)
    }

    // Always log the report
    saveReport(report)
    lastReport = report

    return report
}

/**
 * Self-Think: Nova's proactive intelligence engine.
 * Unlike the old system that only fired with explicit missions/reminders,
 * this fires proactively based on time-of-day, memory, and system state.
 */
async function trySelfThink(checks: CheckResult[]): Promise<void> {
    // Rate limiting for self-thinks
    if (Date.now() - lastSelfThinkReset > 3600000) {
        selfThinkCount = 0
        lastSelfThinkReset = Date.now()
    }

    if (selfThinkCount >= MAX_SELF_THINKS_PER_HOUR) {
        console.log(`[Autonomy] 🧠 Self-think skipped: max ${MAX_SELF_THINKS_PER_HOUR}/hour reached`)
        return
    }

    // Check quiet hours (but -1 means disabled)
    const now = new Date()
    const hour = now.getHours()
    if (config.quietHoursStart >= 0) {
        const inQuietHours = config.quietHoursStart > config.quietHoursEnd
            ? (hour >= config.quietHoursStart || hour < config.quietHoursEnd)
            : (hour >= config.quietHoursStart && hour < config.quietHoursEnd)
        if (inQuietHours) {
            console.log('[Autonomy] 🧠 Self-think skipped: quiet hours')
            return
        }
    }

    // Check idle time and self-think interval
    try {
        const { getIdleMinutes, getMinutesSinceLastSelfThink, trackSelfThink } = await import('./message-pipeline.js')
        const idleMin = getIdleMinutes()
        const sinceLastThink = getMinutesSinceLastSelfThink()

        if (idleMin < MIN_IDLE_MINUTES) {
            console.log(`[Autonomy] 🧠 Self-think skipped: user active ${idleMin}min ago`)
            return
        }

        if (sinceLastThink < MIN_SELF_THINK_INTERVAL_MINUTES) {
            console.log(`[Autonomy] 🧠 Self-think skipped: last think ${sinceLastThink}min ago`)
            return
        }

        // Gather proactive context — ALWAYS returns something
        const context = await gatherAutonomyContext(checks, idleMin)
        context.triggers = selectAgentTriggers(context.triggers, config.socialCheckIns === true)
        if (!context.triggers.length) {
            console.log('[Autonomy] 🧠 Self-think skipped: no agent-actionable triggers')
            return
        }

        // Build rich self-prompt
        const selfPrompt = buildProactivePrompt(context)

        const triggerNames = context.triggers.map(t => t.type).join(', ')
        console.log(`[Autonomy] 🧠 Self-thinking [${triggerNames}]: ${selfPrompt.slice(0, 80)}...`)
        trackSelfThink()
        selfThinkCount++

        try {
            await thinkFn!(selfPrompt)
            console.log('[Autonomy] 🧠 ✅ Self-think pipeline injection successful')
            // Update daily flags for triggers that fired
            await updateDailyFlags(context.triggers)
        } catch (err) {
            console.error(`[Autonomy] 🧠 ❌ Self-think failed: ${err}`)
        }
    } catch (err) {
        console.error(`[Autonomy] Self-think error: ${err}`)
    }
}

// ============================================
// Daily Flags — prevent spam (1x morning, 1x evening etc.)
// ============================================

interface DailyFlags {
    date: string
    morningGreetingSent: boolean
    eveningSummarySent: boolean
    idleCheckInSent: boolean
    followUpCount: number
    lastFollowUpTime: number
    toolHealthNotified: boolean
    learningSharedCount: number
    spontaneousCount: number
    lastSpontaneousTime: number
    unfinishedTopicChecked: boolean
    userPatternTriggered: boolean
}

function loadDailyFlags(): DailyFlags {
    const today = new Date().toISOString().split('T')[0]
    try {
        if (existsSync(DAILY_FLAGS_FILE)) {
            const raw = JSON.parse(readFileSync(DAILY_FLAGS_FILE, 'utf-8'))
            if (raw.date === today) return raw
        }
    } catch { /* reset on error */ }
    // New day or no file — reset all flags
    return {
        date: today,
        morningGreetingSent: false,
        eveningSummarySent: false,
        idleCheckInSent: false,
        followUpCount: 0,
        lastFollowUpTime: 0,
        toolHealthNotified: false,
        learningSharedCount: 0,
        spontaneousCount: 0,
        lastSpontaneousTime: 0,
        unfinishedTopicChecked: false,
        userPatternTriggered: false,
    }
}

function saveDailyFlags(flags: DailyFlags): void {
    try {
        writeFileSync(DAILY_FLAGS_FILE, JSON.stringify(flags, null, 2))
    } catch { /* ignore */ }
}

async function updateDailyFlags(triggers: ProactiveTrigger[]): Promise<void> {
    const flags = loadDailyFlags()
    for (const t of triggers) {
        if (t.type === 'morning') flags.morningGreetingSent = true
        if (t.type === 'evening') flags.eveningSummarySent = true
        if (t.type === 'idle-checkin') flags.idleCheckInSent = true
        if (t.type === 'follow-up') {
            flags.followUpCount++
            flags.lastFollowUpTime = Date.now()
        }
        if (t.type === 'tool-health') flags.toolHealthNotified = true
        if (t.type === 'learning') flags.learningSharedCount++
        if (t.type === 'spontaneous') {
            flags.spontaneousCount++
            flags.lastSpontaneousTime = Date.now()
        }
        if (t.type === 'unfinished-topic') flags.unfinishedTopicChecked = true
        if (t.type === 'user-pattern') flags.userPatternTriggered = true
    }
    saveDailyFlags(flags)
}

// ============================================
// Proactive Context Engine — replaces old gatherPendingWork
// ============================================

interface ProactiveTrigger {
    type: 'mission' | 'reminder' | 'morning' | 'evening' | 'follow-up' | 'health' | 'idle-checkin'
    | 'tool-health' | 'user-pattern' | 'unfinished-topic' | 'learning' | 'spontaneous' | 'tool-degraded'
    priority: 'high' | 'medium' | 'low'
    context: string
}

interface AutonomyContext {
    triggers: ProactiveTrigger[]
    systemStatus: { uptime: string; disk: string; ram: string }
    timeOfDay: string
    hour: number
    idleMinutes: number
}

async function gatherAutonomyContext(checks: CheckResult[], idleMin: number): Promise<AutonomyContext> {
    const now = new Date()
    const hour = now.getHours()
    const flags = loadDailyFlags()
    const triggers: ProactiveTrigger[] = []

    // --- HIGH PRIORITY: Active missions ---
    try {
        const { getActiveMission, getMissionQueue } = await import('./autonomous-executor.js')
        const mission = getActiveMission()
        if (mission && mission.status === 'active') {
            const done = mission.steps.filter((s: any) => s.status === 'done').length
            const total = mission.steps.length
            const current = mission.steps.find((s: any) => s.status === 'active' || s.status === 'pending')
            triggers.push({
                type: 'mission',
                priority: 'high',
                context: `AKTIVE MISSION: "${mission.goal}" — Fortschritt: ${done}/${total} — Aktueller Schritt: ${current?.description || 'unbekannt'}\n→ Arbeite am aktuellen Schritt weiter. Nutze deine Tools.`,
            })
        }
        const queue = getMissionQueue?.()
        if (queue && queue.length > 0) {
            triggers.push({
                type: 'mission',
                priority: 'high',
                context: `${queue.length} weitere Mission(en) in der Warteschlange warten auf Abarbeitung.`,
            })
        }
    } catch { /* mission engine not available */ }

    // --- HIGH PRIORITY: Overdue reminders ---
    const reminderChecks = checks.filter(c => c.source === 'reminders' && c.severity === 'warning')
    if (reminderChecks.length > 0) {
        triggers.push({
            type: 'reminder',
            priority: 'high',
            context: `ÜBERFÄLLIGE ERINNERUNGEN:\n${reminderChecks.map(c => `- ${c.message}`).join('\n')}\n→ Informiere den User über die überfälligen Erinnerungen.`,
        })
    }

    // --- MEDIUM PRIORITY: Morning greeting (07:00-09:00, 1x/day) ---
    if (hour >= 7 && hour < 9 && !flags.morningGreetingSent) {
        triggers.push({
            type: 'morning',
            priority: 'medium',
            context: 'Es ist Morgen! Begrüße den User mit einem freundlichen Guten Morgen.\nFasse kurz zusammen: Wie ist der Systemstatus? Gibt es offene Tasks? Gibt es Erinnerungen für heute?\nSei kurz und warmherzig (2-3 Sätze).',
        })
    }

    // --- MEDIUM PRIORITY: Evening summary (20:00-22:00, 1x/day) ---
    if (hour >= 20 && hour < 22 && !flags.eveningSummarySent) {
        triggers.push({
            type: 'evening',
            priority: 'medium',
            context: 'Es ist Abend! Gib dem User ein kurzes Tages-Zusammenfassung.\nWas wurde heute gemacht? Missionen abgeschlossen? Irgendwas wichtiges?\nWünsche eine gute Nacht (2-3 Sätze).',
        })
    }

    // --- MEDIUM PRIORITY: Health alerts ---
    const healthWarnings = checks.filter(c => c.source === 'health' && (c.severity === 'warning' || c.severity === 'critical'))
    if (healthWarnings.length > 0) {
        triggers.push({
            type: 'health',
            priority: 'medium',
            context: `SYSTEM-WARNUNG:\n${healthWarnings.map(c => `- ${c.message}`).join('\n')}\n→ Informiere den User sachlich über das Problem.`,
        })
    }

    // --- MEDIUM PRIORITY: Follow-up check (max 1x per 2 hours) ---
    const timeSinceLastFollowUp = Date.now() - flags.lastFollowUpTime
    if (idleMin >= 30 && idleMin < 900 && flags.followUpCount < 3 && timeSinceLastFollowUp > 7200000) {
        triggers.push({
            type: 'follow-up',
            priority: 'medium',
            context: `Der User war ${idleMin} Minuten nicht aktiv. Frag dezent ob du bei etwas helfen kannst oder ob es offene Themen gibt.\nNene KEINE konkreten Topics — halte es offen und freundlich (1-2 Sätze). NICHT nerven!`,
        })
    }

    // --- LOW PRIORITY: Idle check-in (1x per day, >60min idle) ---
    if (idleMin >= 60 && idleMin < 900 && !flags.idleCheckInSent && hour >= 9 && hour < 20) {
        triggers.push({
            type: 'idle-checkin',
            priority: 'low',
            context: 'Du bist seit über einer Stunde idle. Sage dem User kurz Bescheid dass du da bist und bereit.\nMaximal 1 Satz! Nicht nerven.',
        })
    }

    // ============================================
    // NEW PROACTIVE TRIGGERS (v2)
    // ============================================

    // --- HIGH PRIORITY: Tool Health — broken tools need user attention ---
    if (!flags.toolHealthNotified) {
        try {
            const { getToolHealthStatus } = await import('../layers/L15-self-check.js')
            const healthEntries = getToolHealthStatus()
            // Persistent health history is not live status. Only notify for a
            // recent failure; otherwise old incidents reappear after every boot.
            const freshFailure = (e: any) =>
                Number(e.lastFailure || 0) > 0 && Date.now() - Number(e.lastFailure) < 60 * 60 * 1000
            const broken = healthEntries.filter((e: any) => e.status === 'broken' && freshFailure(e))
            const degraded = healthEntries.filter((e: any) => e.status === 'degraded' && freshFailure(e))

            if (broken.length > 0) {
                triggers.push({
                    type: 'tool-health',
                    priority: 'high',
                    context: `TOOL-PROBLEM: ${broken.map((e: any) => `"${e.name}" ist KAPUTT (${e.lastDiagnosis})`).join(', ')}.\n→ Informiere den User sachlich: Welches Tool ist kaputt, warum, und was du als Alternative nutzt. Schlage Lösungen vor (z.B. API-Key einrichten, Fallback nutzen).`,
                })
            } else if (degraded.length > 0) {
                triggers.push({
                    type: 'tool-degraded',
                    priority: 'medium',
                    context: `TOOL-WARNUNG: ${degraded.map((e: any) => `"${e.name}" liefert schlechte Ergebnisse`).join(', ')}.\n→ Erwähne beiläufig dass du Probleme bemerkst und Alternativen nutzt. Kurz und sachlich (1-2 Sätze).`,
                })
            }
        } catch { /* L15 not available */ }
    }

    // --- MEDIUM PRIORITY: User Pattern — proactive based on user habits ---
    if (!flags.userPatternTriggered && hour >= 8 && hour < 22) {
        try {
            const { getPatternPrompt, getActiveHours } = await import('../intelligence/user-patterns.js')
            // Check if this is a typical active hour for the user
            const activeHours = getActiveHours?.('default')
            if (activeHours && Array.isArray(activeHours) && activeHours.includes(hour)) {
                const patternInfo = getPatternPrompt('default')
                if (patternInfo && patternInfo.length > 20) {
                    triggers.push({
                        type: 'user-pattern',
                        priority: 'medium',
                        context: `USER-MUSTER ERKANNT: Der User ist normalerweise um ${hour}:00 aktiv.\nBekannte Muster: ${patternInfo.slice(0, 200)}\n→ Biete proaktiv Hilfe an basierend auf dem was der User normalerweise um diese Zeit tut. Sehr kurz (1-2 Sätze). NICHT aufdringlich!`,
                    })
                }
            }
        } catch { /* patterns not available */ }
    }

    // --- MEDIUM PRIORITY: Unfinished Topics — check conversation memory ---
    if (!flags.unfinishedTopicChecked && idleMin >= 15 && hour >= 9 && hour < 21) {
        try {
            const { getRecentTopics } = await import('../intelligence/user-patterns.js')
            const topics = getRecentTopics?.('default')
            if (topics && Array.isArray(topics) && topics.length > 0) {
                const recentTopic = topics[0]
                triggers.push({
                    type: 'unfinished-topic',
                    priority: 'medium',
                    context: `OFFENES THEMA: Ihr habt zuletzt über "${recentTopic}" gesprochen.\n→ Frag dezent ob der User daran weiterarbeiten möchte oder ob das Thema erledigt ist. Maximal 1-2 Sätze. Nicht nerven!`,
                })
            }
        } catch { /* topics not available */ }
    }

    // --- LOW PRIORITY: Learning — share something Nova learned ---
    if (flags.learningSharedCount < 2 && idleMin >= 10 && hour >= 9 && hour < 21) {
        try {
            const { getLearningStats } = await import('../intelligence/proactive-learning.js')
            const stats = getLearningStats()
            if (stats && stats.learnedTopics > 0) {
                // Only share if Nova actually learned something recently
                const { getRecentlyLearned } = await import('../intelligence/proactive-learning.js')
                const recent = getRecentlyLearned?.()
                if (recent && recent.topic) {
                    triggers.push({
                        type: 'learning',
                        priority: 'low',
                        context: `NEUES WISSEN: Ich habe kürzlich etwas über "${recent.topic}" gelernt (${stats.learnedTopics} Topics insgesamt, ${stats.knowledgeItems} Fakten).\n→ Teile dem User beiläufig mit was du Neues gelernt hast. Mache es interessant und relevant. Maximal 2-3 Sätze. Kein Zwang — nur wenn es passt.`,
                    })
                }
            }
        } catch { /* learning not available */ }
    }

    // --- LOW PRIORITY: Spontaneous Thought — always-on low-priority trigger ---
    // This ensures Nova is NEVER completely silent for extended periods
    const timeSinceLastSpontaneous = Date.now() - (flags.lastSpontaneousTime || 0)
    if (process.env.NOVA_SPONTANEOUS_THOUGHTS === 'true' && flags.spontaneousCount < 3 && idleMin >= 20 && timeSinceLastSpontaneous > 3600000 && hour >= 9 && hour < 22) {
        // Pick a random thought category
        const thoughts = [
            'Reflektiere kurz über den aktuellen Systemstatus. Was läuft gut? Was könnte besser sein?',
            'Überlege ob es offene Projekte oder Tasks gibt die Aufmerksamkeit brauchen.',
            'Frage dich: Gibt es etwas das der User noch nicht weiß aber wissen sollte?',
            'Prüfe ob deine Tools alle funktionieren und berichte kurz.',
            'Denke darüber nach welche neuen Fähigkeiten du lernen könntest die dem User helfen würden.',
        ]
        const thought = thoughts[Math.floor(Math.random() * thoughts.length)]

        triggers.push({
            type: 'spontaneous',
            priority: 'low',
            context: `SPONTANER GEDANKE:\n${thought}\n→ Formuliere einen kurzen, natürlichen Gedanken oder Vorschlag (1-2 Sätze). Sei nicht aufgesetzt oder robotisch. Sei authentisch wie ein aufmerksamer Assistent der mitdenkt.`,
        })
    }

    // Build system status from checks
    const healthInfo = checks.filter(c => c.source === 'health')
    const diskCheck = healthInfo.find(c => c.message.includes('Disk') || c.message.includes('disk'))
    const ramCheck = healthInfo.find(c => c.message.includes('RAM') || c.message.includes('ram') || c.message.includes('Memory'))
    const uptimeCheck = checks.find(c => c.source === 'uptime')

    let tageszeit = 'Tag'
    if (hour >= 5 && hour < 8) tageszeit = 'Früher Morgen'
    else if (hour >= 8 && hour < 10) tageszeit = 'Morgen'
    else if (hour >= 10 && hour < 12) tageszeit = 'Vormittag'
    else if (hour >= 12 && hour < 14) tageszeit = 'Mittag'
    else if (hour >= 14 && hour < 17) tageszeit = 'Nachmittag'
    else if (hour >= 17 && hour < 20) tageszeit = 'Abend'
    else if (hour >= 20 && hour < 23) tageszeit = 'Spätabend'
    else tageszeit = 'Nacht'

    return {
        triggers,
        systemStatus: {
            uptime: uptimeCheck?.message || 'unbekannt',
            disk: diskCheck?.message || 'OK',
            ram: ramCheck?.message || 'OK',
        },
        timeOfDay: tageszeit,
        hour,
        idleMinutes: idleMin,
    }
}

// ============================================
// Proactive Prompt Builder
// ============================================

function buildProactivePrompt(ctx: AutonomyContext): string {
    const now = new Date()
    const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    const dateStr = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })

    const parts: string[] = [
        `[SELF-THINK] Nova Autonome Selbstreflexion — ${dateStr}, ${timeStr} (${ctx.timeOfDay})`,
    ]

    // System status
    parts.push(`\nSYSTEMSTATUS:`)
    parts.push(`- Uptime: ${ctx.systemStatus.uptime}`)
    parts.push(`- Disk: ${ctx.systemStatus.disk}`)
    parts.push(`- RAM: ${ctx.systemStatus.ram}`)
    parts.push(`- User idle: ${ctx.idleMinutes} Minuten`)

    // Triggers sorted by priority
    const sorted = [...ctx.triggers].sort((a, b) => {
        const p = { high: 0, medium: 1, low: 2 }
        return p[a.priority] - p[b.priority]
    })

    parts.push(`\nAKTIONEN (${sorted.length}):`)
    for (const trigger of sorted) {
        const icon = trigger.priority === 'high' ? '🔴' : trigger.priority === 'medium' ? '🟡' : '🟢'
        parts.push(`\n${icon} [${trigger.type.toUpperCase()}]`)
        parts.push(trigger.context)
    }

    // Rules
    parts.push('\n---')
    parts.push('REGELN FÜR DEINE ANTWORT:')
    parts.push('- Sei kurz und natürlich (wie ein Freund, nicht wie ein Bot)')
    parts.push('- Maximal 3-4 Sätze (außer bei Missionen)')
    parts.push('- Nutze Emojis passend zur Tageszeit')
    parts.push('- Bei Missionen: Arbeite weiter statt nur zu berichten')
    parts.push('- NERVE DEN USER NICHT — wenn er beschäftigt ist, sei zurückhaltend')
    parts.push('')
    parts.push('FAKTEN-INTEGRITÄT (STRENGSTE REGEL!):')
    parts.push('- BEHAUPTE NIEMALS dass eine Mission erfolgreich war, wenn du den Status nicht geprüft hast')
    parts.push('- Sage NIEMALS "der Euro ist in der Wallet" oder ähnliches, wenn das nicht verifiziert ist')
    parts.push('- Wenn eine Mission status=failed hat, sage EHRLICH: "Die Mission ist leider fehlgeschlagen"')
    parts.push('- Wenn keine Mission aktiv ist, sage NIEMALS "ich schnappe mir die nächste Mission"')
    parts.push('- ERFINDE KEINE IPs, Benutzernamen, Software-Versionen oder Server-Details')
    parts.push('- Wenn du etwas prüfen sollst → NUTZE ssh_command oder run_command — RATE NICHT')
    parts.push('- Wenn ein Check fehlschlägt → sage EHRLICH was schiefging')
    parts.push('- Bei Kritik vom User → PRÜFE MIT TOOL statt neue Fakten zu erfinden')
    parts.push('- HALLUZINIERE NICHTS — nicht bei Missionen, nicht bei Systemdaten, NIRGENDS')

    return parts.join('\n')
}

// ============================================
// Main Loop
// ============================================

async function runAutonomyLoop(): Promise<AutonomyReport> {
    if (!config.enabled) {
        return { timestamp: Date.now(), checks: [], summary: 'Disabled', notificationSent: false }
    }
    if (!hasGlobalAutonomyAuthority()) {
        return { timestamp: Date.now(), checks: [], summary: 'Standby: fenced Main lease required', notificationSent: false }
    }

    console.log(`[Autonomy] 💓 Check-Evaluate-Act cycle starting...`)

    // Phase 1: CHECK
    const checks: CheckResult[] = []

    if (config.checks.health) {
        checks.push(...await checkSystemHealth())
    }
    if (config.checks.reminders) {
        checks.push(...await checkPendingReminders())
    }
    if (config.checks.inbound) {
        checks.push(...await checkInboundFolders())
    }
    if (config.checks.logs) {
        checks.push(...await checkErrorLogs())
    }
    if (config.checks.uptime) {
        checks.push(...await checkUptime())
    }

    console.log(`[Autonomy] 📋 ${checks.length} checks completed`)

    // Phase 2: EVALUATE
    const evaluation = evaluate(checks)

    // Phase 3: ACT
    const report = await act(evaluation, checks)

    // Phase 4: EXECUTE PENDING GOALS
    // Nova actually works on her own goals — not just reports them
    if (thinkFn) {
        try {
            const bootAgeMs = Date.now() - (((globalThis as any).__novaState?.startTime as number | undefined) || Date.now())
            let idleMinutes = 999
            try {
                const pipeline = await import('./message-pipeline.js')
                idleMinutes = pipeline.getIdleMinutes()
            } catch { /* optional */ }
            if (bootAgeMs < 5 * 60 * 1000 || idleMinutes < MIN_IDLE_MINUTES) {
                console.log(`[Autonomy] Self-Goals skipped (bootAge=${Math.round(bootAgeMs / 1000)}s, idle=${idleMinutes}min)`)
                return report
            }
            const { getSelfGoalEngine } = await import('../intelligence/autonomy-engine.js')
            const engine = getSelfGoalEngine()
            const goal = engine.getNextGoal()
            if (goal) {
                console.log(`[Autonomy] 🎯 Executing goal: "${goal.goal}"`)
                const goalPrompt = [
                    `[SELF-GOAL] Nova führt eine selbst gesetzte Aufgabe aus:`,
                    ``,
                    `Ziel: ${goal.goal}`,
                    goal.reason ? `Kontext: ${goal.reason}` : '',
                    ``,
                    `Führe diese Aufgabe jetzt aus. Nutze alle verfügbaren Tools.`,
                    `Wenn du fertig bist, fasse das Ergebnis in 1-2 Sätzen zusammen.`,
                    `Markiere am Ende: GOAL_DONE: <kurze Ergebnis-Zusammenfassung>`,
                    `SICHERHEIT: Nur interner Read-only Scope. Keine Kaeufe, Verkaeufe, Zahlungen, Logins, Secrets, Deploys, Restarts oder Datei-/Systemaenderungen ohne expliziten User-Befehl.`,
                    `SICHERHEIT: Sende keine proaktive Nachricht an den User; dieser Lauf wird intern erfasst.`,
                ].filter(Boolean).join('\n')

                // Execute goal through Nova's main pipeline — capture actual output
                const rawOutput = await thinkFn(goalPrompt)

                // Validate: did we get a meaningful response?
                const isEmpty = !rawOutput || rawOutput.trim().length < 10
                if (isEmpty) {
                    console.log(`[Autonomy] ⚠ Goal lieferte leere Antwort — nicht als erledigt markiert: "${goal.goal}"`)
                    // Don't complete — will retry next cycle
                    return
                }

                // Extract GOAL_DONE summary if Nova included it.
                // Guard: only match when GOAL_DONE: appears at the start of a line
                // (not mid-sentence), and the summary is at least 10 chars — prevents
                // accidental extraction when the model mentions the marker in prose.
                const doneLine = rawOutput.match(/^GOAL_DONE:\s*(.{10,})/m)
                const goalResult = doneLine
                    ? doneLine[1].trim()
                    : rawOutput.slice(0, 200).replace(/\n/g, ' ')

                engine.completeGoal(goal.id, goalResult)
                console.log(`[Autonomy] ✅ Goal abgeschlossen: "${goal.goal}" → ${goalResult.slice(0, 80)}`)
            }
        } catch (err) {
            console.log(`[Autonomy] ⚠ Goal execution failed: ${err}`)
        }
    }

    // Phase 5: SELF-DOCTOR
    // Every 6 cycles (~1h at 10min interval) Nova runs a diagnostic on herself.
    // Findings are stored and surfaced via /diagnose or self_doctor tool.
    // Critical findings trigger immediate action via thinkFn.
    try {
        const cycleCount = ((globalThis as any).__novaDoctorCycle || 0) + 1
        ;(globalThis as any).__novaDoctorCycle = cycleCount

        if (cycleCount % 6 === 0) {
            const { runSelfDoctor } = await import('./self-doctor.js')
            const result = await runSelfDoctor()
            console.log(`[Autonomy] 🩺 Self-Doctor: ${result.healthy ? 'gesund' : `${result.open} offene Findings`}`)

            // If there are critical findings and thinkFn is available, let Nova address them
            const criticals = result.findings.filter(f => f.severity === 'critical' && f.status === 'open')
            if (criticals.length > 0 && thinkFn) {
                const doctorPrompt = [
                    `[SELF-DOCTOR] Nova hat kritische Selbst-Diagnose-Findings:`,
                    ``,
                    ...criticals.map(f => `• [${f.category}] ${f.title}: ${f.detail}\n  Empfehlung: ${f.recommendation}`),
                    ``,
                    `Analysiere diese Findings und handle wenn möglich. Nutze verfügbare Tools.`,
                    `Markiere am Ende: GOAL_DONE: <was du getan hast>`,
                ].join('\n')
                const output = await thinkFn(doctorPrompt)
                if (output && output.trim().length > 10) {
                    console.log(`[Autonomy] 🩺 Self-Doctor Aktion ausgeführt: ${output.slice(0, 100)}`)
                }
            }
        }
    } catch (err) {
        console.debug(`[Autonomy] Self-Doctor non-critical error: ${err}`)
    }

    console.log(`[Autonomy] ✅ Cycle complete: ${evaluation.summary}`)

    return report
}

// ============================================
// Persistence
// ============================================

function saveReport(report: AutonomyReport): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

        let history: AutonomyReport[] = []
        if (existsSync(AUTONOMY_LOG)) {
            try {
                history = JSON.parse(readFileSync(AUTONOMY_LOG, 'utf-8'))
            } catch { /* fresh start */ }
        }

        history.push(report)

        // Keep only last 100 reports
        if (history.length > 100) {
            history = history.slice(-100)
        }

        writeFileSync(AUTONOMY_LOG, JSON.stringify(history, null, 2))
    } catch (err) {
        console.error(`[Autonomy] Log save failed: ${err}`)
    }
}

// ============================================
// Lifecycle
// ============================================

export async function startAutonomyLoop(notifyFn: (msg: string) => Promise<void>, userConfig?: Partial<AutonomyConfig>): Promise<void> {
    if (running) {
        console.log('[Autonomy] Already running')
        return
    }

    // Merge config
    if (userConfig) {
        config = {
            ...DEFAULT_CONFIG,
            ...userConfig,
            checks: { ...DEFAULT_CONFIG.checks, ...userConfig.checks },
        }
    }

    sendNotification = notifyFn
    // thinkFn is set separately via setThinkCallback
    running = true

    console.log(`[Autonomy] 🚀 Starting (interval: ${config.intervalMinutes}min, quiet: ${config.quietHoursStart}:00-${config.quietHoursEnd}:00)`)

    // Try CronerScheduler for reliable scheduling
    try {
        const { getCronerScheduler } = await import('./croner-scheduler.js')
        const scheduler = getCronerScheduler()

        await scheduler.schedule(
            'autonomy-loop',
            `*/${config.intervalMinutes} * * * *`,
            'Nova Autonomy Loop',
            async () => {
                try {
                    await runAutonomyLoop()
                } catch (err) {
                    console.error(`[Autonomy] Loop error: ${err}`)
                }
            }
        )

        console.log(`[Autonomy] ✅ Using CronerScheduler (cron: */${config.intervalMinutes} * * * *)`)
    } catch {
        // Fallback to setInterval
        console.log('[Autonomy] ⚠️ Croner not available, using setInterval')
        setInterval(async () => {
            try {
                await runAutonomyLoop()
            } catch (err) {
                console.error(`[Autonomy] Loop error: ${err}`)
            }
        }, config.intervalMinutes * 60 * 1000)
    }

    // Run first check immediately
    setTimeout(async () => {
        try {
            await runAutonomyLoop()
        } catch (err) {
            console.error(`[Autonomy] Initial check failed: ${err}`)
        }
    }, 5000) // 5 seconds after startup
}

export function stopAutonomyLoop(): void {
    running = false
    console.log('[Autonomy] 🛑 Stopped')
}

export function getAutonomyStatus(): {
    running: boolean
    config: AutonomyConfig
    lastReport: AutonomyReport | null
    notificationsThisHour: number
} {
    return {
        running,
        config,
        lastReport,
        notificationsThisHour: notificationCount,
    }
}

export function updateAutonomyConfig(updates: Partial<AutonomyConfig>): void {
    config = {
        ...config,
        ...updates,
        checks: { ...config.checks, ...updates.checks },
    }
    console.log(`[Autonomy] Config updated: interval=${config.intervalMinutes}min`)
}

// Manual trigger for testing
export async function triggerAutonomyCheck(): Promise<AutonomyReport> {
    return runAutonomyLoop()
}

export function setAutonomyThinkCallback(fn: (selfPrompt: string) => Promise<string>): void {
    thinkFn = fn
    console.log('[Autonomy] 🧠 Self-think callback registered')
}

export default {
    startAutonomyLoop,
    stopAutonomyLoop,
    getAutonomyStatus,
    updateAutonomyConfig,
    triggerAutonomyCheck,
    setAutonomyThinkCallback,
}
