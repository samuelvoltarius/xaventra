/**
 * Planner runtime wiring (daemon). P8 "Standard: selbststaendig": on at the
 * Main without any config entry; `autonomy.planner.enabled=false` switches it
 * off (a mesh worker never starts it). Config (all optional):
 *
 *   autonomy.planner.enabled      an      start the planner (false = aus)
 *   autonomy.planner.tickSeconds  30      tick interval
 *   autonomy.planner.reminders    an      set_reminder goes through the planner (false = Rückweg reminders.json + 30-s checker)
 *   (Nachtwache: 2.82.0 runs only in the Wächter, watch/runtime.ts; an old sys-nachtwache job is switched off)
 *   autonomy.briefing.enabled     an      morning/evening report (follows the planner; true starts the planner alone)
 *   autonomy.briefing.morning     "07:30"
 *   autonomy.briefing.evening     "20:00"
 *   autonomy.briefing.timeZone    "Europe/Vienna"
 *   autonomy.quietHours           { start: 22, end: 7 }   the one quiet-hours definition (core/quiet-hours.ts);
 *                                                        only `dringend` gets through (old key autonomy.thoughts.quietHours still read)
 *   autonomy.thoughts.dedupeMinutes 360
 *   autonomy.thoughts.maxPerDay   10
 *
 * P9 „ein Zeitplaner“: the planner is the only scheduler for time-based work.
 * At start it takes over reminders.json, heartbeat.md routines and the old
 * node-cron automation patterns (planner/routines.ts); old files are renamed
 * to `.migriert`, nothing is deleted.
 */

import { join } from 'node:path'
import { defaultOn } from '../core/autonomy-defaults.js'
import { getNovaDataDir } from '../core/data-root.js'
import { onQuietHoursChange, parseQuietHours } from '../core/quiet-hours.js'
import { createBriefingHandler, type BriefingKind } from './briefing.js'
import { getPlannerDeliveryPort, type DeliveryPort } from './delivery-port.js'
import { createPlanner, type Planner, type PlannerJob } from './planner.js'
import { migrateHeartbeatFile, migrateSchedulerPatterns, registerRoutineHandlers, type AutomationPattern } from './routines.js'
import { createThoughtStore, normalizeThoughtSettings, type ThoughtSettings, type ThoughtStore } from './thoughts.js'
import { DEFAULT_TIME_ZONE, HHMM_PATTERN, isValidTimeZone } from './time.js'

export interface PlannerSettings {
    enabled: boolean
    tickSeconds: number
    reminders: boolean
    briefing: { enabled: boolean; morning: string; evening: string; timeZone: string }
    thoughts: ThoughtSettings
}

export interface PlannerRuntime {
    planner: Planner
    thoughts: ThoughtStore
    settings: PlannerSettings
    stop(): void
}

export interface PlannerRuntimeOptions {
    dataDir?: string
    now?: () => number
    authority?: () => boolean | Promise<boolean>
    startTimer?: boolean
    /** Overrides the globally wired port (tests, special adapters). */
    port?: DeliveryPort | null
    nodeId?: string
    /** Where the pre-planner files live (heartbeat.md); default <cwd>/.nova-data. */
    legacyDir?: string
    /** `heartbeat.enabled` from the config (false = migrated routines stay off). */
    heartbeatEnabled?: boolean
    /** Automated cron patterns to take over; default: the pattern store. */
    patterns?: () => readonly AutomationPattern[]
}

export const SYSTEM_JOB_IDS = Object.freeze({
    briefingMorgen: 'sys-briefing-morgen',
    briefingAbend: 'sys-briefing-abend',
    nachtwache: 'sys-nachtwache',
})

export function parsePlannerSettings(autonomy: any, env: NodeJS.ProcessEnv = process.env): PlannerSettings {
    const planner = autonomy?.planner ?? {}
    const briefing = autonomy?.briefing ?? {}
    const thoughts = autonomy?.thoughts ?? {}
    const hhmm = (value: unknown, fallback: string) => typeof value === 'string' && HHMM_PATTERN.test(value) ? value : fallback
    const timeZone = typeof briefing.timeZone === 'string' && isValidTimeZone(briefing.timeZone) ? briefing.timeZone : DEFAULT_TIME_ZONE
    const tick = Number(planner.tickSeconds)
    const plannerOn = defaultOn(planner.enabled, env)
    const quiet = parseQuietHours(autonomy)
    // Missing briefing switch follows the planner; an explicit true starts the planner for the report alone (old behaviour).
    const briefingOn = briefing.enabled === undefined ? plannerOn : defaultOn(briefing.enabled, env)
    return {
        enabled: plannerOn || briefingOn,
        tickSeconds: Number.isFinite(tick) && tick >= 5 ? Math.min(600, Math.floor(tick)) : 30,
        reminders: defaultOn(planner.reminders, env),
        briefing: { enabled: briefingOn, morning: hhmm(briefing.morning, '07:30'), evening: hhmm(briefing.evening, '20:00'), timeZone },
        thoughts: normalizeThoughtSettings({
            quietStart: quiet.start,
            quietEnd: quiet.end,
            timeZone,
            dedupeMinutes: thoughts.dedupeMinutes,
            maxPerDay: thoughts.maxPerDay,
        }),
    }
}

/** Main-only by default: never on a mesh node, only with the fenced Main lease. */
async function defaultAuthority(): Promise<boolean> {
    if (String(process.env.NOVA_NODE_ONLY || '').toLowerCase() === 'true') return false
    const { hasGlobalAutonomyAuthority } = await import('../core/autonomy-authority.js')
    return hasGlobalAutonomyAuthority()
}

let runtime: PlannerRuntime | null = null

export function getPlannerRuntime(): PlannerRuntime | null {
    return runtime
}

export function stopPlannerRuntime(): void {
    if (!runtime) return
    runtime.stop()
    runtime = null
}

type ReminderModule = typeof import('../tools/reminder-tool.js')
type StoredReminder = import('../tools/reminder-tool.js').StoredReminder

function reminderFromJob(job: PlannerJob): StoredReminder {
    const p = job.payload as Record<string, unknown>
    return {
        id: String(p.reminderId || job.id),
        message: String(p.message || ''),
        triggerAt: Date.parse(job.nextRunAt || (job.schedule.type === 'einmal' ? job.schedule.at : '')) || 0,
        userId: String(p.userId || 'unknown'),
        channel: String(p.channel || 'Telegram'),
        createdAt: Number(p.createdAt) || 0,
        fired: false,
    }
}

function addReminderJob(planner: Planner, reminder: StoredReminder): PlannerJob {
    return planner.addJob({
        kind: 'erinnerung',
        title: 'Erinnerung',
        idKey: `reminder:${reminder.id}`,
        schedule: { type: 'einmal', at: new Date(reminder.triggerAt).toISOString() },
        delivers: true,
        payload: { reminderId: reminder.id, message: reminder.message, userId: reminder.userId, channel: reminder.channel, createdAt: reminder.createdAt },
    })
}

/** Rückweg: open planner reminders go back to reminders.json when the planner
 * (or its reminder mode) is switched off, so nothing is stranded. */
function returnRemindersToLegacy(planner: Planner, reminders: ReminderModule): number {
    const open = planner.listJobs({ kind: 'erinnerung', status: 'aktiv' })
    if (open.length === 0) return 0
    reminders.restoreLegacyReminders(open.map(reminderFromJob))
    for (const job of open) planner.completeJob(job.id, 'zurueck-in-altweg')
    console.log(`[Planer] ${open.length} Erinnerung(en) zurück in den alten Weg gelegt`)
    return open.length
}

function registerReminders(planner: Planner, reminders: ReminderModule): void {
    planner.register('erinnerung', {
        async run(job) {
            const r = reminderFromJob(job)
            return {
                summary: 'Erinnerung fällig',
                outgoing: { kind: 'erinnerung', title: 'Erinnerung', text: reminders.formatReminderNotification(r.message), urgency: 'dringend', target: { userId: r.userId, channel: r.channel } },
            }
        },
        // Same as the old path: wake the pipeline once the reminder was
        // delivered, or after giving up on delivery.
        afterDelivery: job => reminders.wakeReminderPipeline(reminderFromJob(job)),
        afterGiveUp: job => reminders.wakeReminderPipeline(reminderFromJob(job)),
    })
}

function reminderPort(reminders: ReminderModule): DeliveryPort {
    return {
        name: 'erinnerung-callback',
        async deliver(message) {
            const sent = await reminders.sendReminderText(message.target?.userId || 'unknown', message.target?.channel || 'Telegram', message.text)
            return sent ? { status: 'zugestellt' } : { status: 'kein-port', detail: 'kein Erinnerungs-Kanal registriert' }
        },
    }
}

export async function startPlannerRuntime(autonomyConfig: unknown, options: PlannerRuntimeOptions = {}): Promise<PlannerRuntime | null> {
    stopPlannerRuntime()
    const settings = parsePlannerSettings(autonomyConfig)
    const dataDir = options.dataDir ?? getNovaDataDir()
    const reminders = await import('../tools/reminder-tool.js')
    const thoughts = createThoughtStore({ dataDir, now: options.now, settings: settings.thoughts })
    const planner = createPlanner({
        dataDir,
        now: options.now,
        authority: options.authority ?? defaultAuthority,
        nodeId: options.nodeId ?? process.env.NOVA_NODE_ID ?? 'lokal',
        thoughts,
        briefingEnabled: () => settings.briefing.enabled,
        ports: {
            default: () => options.port !== undefined ? options.port : getPlannerDeliveryPort(),
            byKind: { erinnerung: reminderPort(reminders) },
        },
    })

    if (!settings.enabled || !settings.reminders) {
        reminders.setReminderSink(null)
        returnRemindersToLegacy(planner, reminders)
        await reminders.useLegacyReminderPath()
    }
    if (!settings.enabled) return null

    registerReminders(planner, reminders)
    // 2.86 Paket N: device routines (only the targets of the owner's Ja) and „nochmal, wenn erreichbar“ (once).
    const { registerDeviceJobs, productionSchaltDeps } = await import('../sensing/device-switch.js')
    const deviceJobDeps = { ...(await productionSchaltDeps()), dataDir, timeZone: settings.briefing.timeZone, planer: () => planner }
    registerDeviceJobs(planner, () => deviceJobDeps)
    registerRoutineHandlers(planner, {
        ownerChatId: () => reminders.getAdminChatId(),
        wake: (userId, channel, text) => reminders.wakePipeline(userId, channel, text),
    })
    try {
        const routines = migrateHeartbeatFile(planner, {
            legacyDir: options.legacyDir ?? join(process.cwd(), '.nova-data'),
            timeZone: settings.briefing.timeZone,
            enabled: options.heartbeatEnabled,
        })
        if (routines.renamed) console.log(`[Planer] ${routines.moved} Routine(n) aus heartbeat.md übernommen (Datei → ${routines.renamed})`)
    } catch (error) {
        console.warn('[Planer] heartbeat.md nicht übernommen:', (error as Error)?.message)
    }
    try {
        const patterns = options.patterns ? options.patterns() : (await import('../learning/pattern-store.js')).getPatternStore().getAutomatedPatterns()
        const automations = migrateSchedulerPatterns(planner, patterns, settings.briefing.timeZone)
        if (automations.skipped.length) console.warn(`[Planer] Automatik-Muster nicht übernommen (nur tägliche Zeiten „M H * * *“): ${automations.skipped.join(', ')}`)
    } catch (error) {
        console.warn('[Planer] Automatik-Muster nicht übernommen:', (error as Error)?.message)
    }
    const { bundledCards, releaseBundledCards, expiredCardsSince } = await import('../core/approval-cards.js')
    const { waitingQuestionCount } = await import('../core/question-queue.js')
    const { isBundleVisible } = await import('../core/card-bundle.js')
    const { trustChangesSince } = await import('../core/action-policy.js')
    const { getOutcomeRouter } = await import('../routing/outcome-router.js')
    const { suggestionSummaryLines } = await import('../core/decisions.js')
    const briefingSources = {
        dataDir, thoughts, runsFile: planner.paths.runs, timeZone: settings.briefing.timeZone,
        // The planner's clock, not the wall clock (the briefing window and the card validity must agree).
        cards: { bundled: () => bundledCards({ dataDir, now: options.now }), release: () => releaseBundledCards({ dataDir, now: options.now }), expiredSince: (since: number, until: number) => expiredCardsSince(since, until, { dataDir, now: options.now }),
            waiting: () => waitingQuestionCount({ dataDir, now: options.now, bundleVisible: key => isBundleVisible(key, { dataDir }), bundleIntoReport: settings.briefing.enabled }) },
        trust: { changesSince: (since: number, until: number) => trustChangesSince(since, until, { dataDir }) },
        learning: {
            successTrend: (now: number) => getOutcomeRouter().successTrend(now),
            // Package C counts Ja/Nein per suggestion kind (decisions.ts); D shows it here.
            suggestionLines: (since: number) => suggestionSummaryLines(since),
            // 2.84 Lern-Puls: Zufluss je Lernspeicher und Nutzen (learning/learning-flow.ts).
            flowLines: async (now: number) => {
                const { learningFlow, learningFlowLines } = await import('../learning/learning-flow.js')
                return learningFlowLines(await learningFlow(now))
            },
        },
    }
    for (const [id, kind, time] of [
        [SYSTEM_JOB_IDS.briefingMorgen, 'morgen', settings.briefing.morning],
        [SYSTEM_JOB_IDS.briefingAbend, 'abend', settings.briefing.evening],
    ] as Array<[string, BriefingKind, string]>) {
        const jobKind = `briefing-${kind}`
        planner.register(jobKind, createBriefingHandler({ kind, sources: briefingSources }))
        planner.upsertSystemJob({
            id, kind: jobKind, title: kind === 'morgen' ? 'Morgenbericht' : 'Abendbericht',
            schedule: { type: 'taeglich', time, timeZone: settings.briefing.timeZone },
            delivers: true, enabled: settings.briefing.enabled, maxLateMinutes: 180, expiresAfterMinutes: 6 * 60,
        })
    }

    // 2.82.0 ein Wächter: the Nachtwache runs only in the Wächter; a job from
    // an earlier release is switched off, never run twice.
    if (planner.getJob(SYSTEM_JOB_IDS.nachtwache)?.enabled) planner.setEnabled(SYSTEM_JOB_IDS.nachtwache, false)

    if (settings.reminders) {
        reminders.setReminderSink({
            add: reminder => { addReminderJob(planner, reminder) },
            list: () => planner.listJobs({ kind: 'erinnerung', status: 'aktiv' }).map(reminderFromJob),
        })
        const moved = reminders.takeLegacyReminders(list => { for (const reminder of list) addReminderJob(planner, reminder) })
        if (moved > 0) console.log(`[Planer] ${moved} Erinnerung(en) aus reminders.json übernommen`)
    }

    if (options.startTimer !== false) planner.start(settings.tickSeconds * 1000)
    // /autonomy quiet changes the one quiet-hours definition; the thoughts follow it at once.
    const stopQuietListener = onQuietHoursChange(value => {
        thoughts.settings.quietStart = value.start
        thoughts.settings.quietEnd = value.end
    })
    const handle: PlannerRuntime = {
        planner,
        thoughts,
        settings,
        stop: () => {
            stopQuietListener()
            planner.stop()
            if (settings.reminders) reminders.setReminderSink(null)
        },
    }
    runtime = handle
    console.log(`[Planer] aktiv (Tick ${settings.tickSeconds}s, Erinnerungen ${settings.reminders ? 'Planer' : 'alter Weg'}, Bericht ${settings.briefing.enabled ? `${settings.briefing.morning}/${settings.briefing.evening}` : 'aus'})`)
    return handle
}
