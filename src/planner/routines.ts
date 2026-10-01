/**
 * P9 „ein Zeitplaner“: what used to run on its own timers now runs as planner
 * jobs with one run log, one delivery log and one idempotency record.
 *
 * | early path | now | migration |
 * |------------|-----|-----------|
 * | `heartbeat.md` routines (`HH:MM | Aufgabe`, core/heartbeat.ts, 5-min checker) | job kind `routine`, daily | once at planner start, file → `heartbeat.md.migriert` |
 * | node-cron patterns (scheduler/nova-scheduler.ts, pattern store `automated` + cron) | job kind `automatik`, daily | once at planner start, idempotent per pattern id |
 * | `reminders.json` (tools/reminder-tool.ts, 30-s checker) | job kind `erinnerung` (planner/runtime.ts) | `reminders.json.migriert` |
 *
 * A routine is the owner's own instruction (from heartbeat.md or /routine): at
 * its time the owner gets a short note and the pipeline is woken with the
 * routine text (system-authored, as before). An `automatik` job delivers the
 * result of a fixed action (news, weather, summary, reminder) to the
 * pattern's user. Delivery goes through the planner's delivery log
 * (`jobId@slot` zugestellt = never again), so a restart never sends twice.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanText } from './delivery-port.js'
import { markMigrated } from './migration-files.js'
import type { NewJob, Planner, PlannerJob } from './planner.js'
import { DEFAULT_TIME_ZONE, HHMM_PATTERN } from './time.js'

export const ROUTINE_KIND = 'routine'
export const AUTOMATION_KIND = 'automatik'

export interface HeartbeatRoutine { time: string; task: string }

/** `HH:MM | Aufgabe` lines; comments (#) and anything else are ignored. */
export function parseHeartbeatRoutines(content: string): HeartbeatRoutine[] {
    const routines: HeartbeatRoutine[] = []
    for (const line of String(content || '').split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue
        const match = /^\s*(\d{1,2}):(\d{2})\s*\|\s*(.+)$/.exec(line)
        if (!match) continue
        const time = `${match[1].padStart(2, '0')}:${match[2]}`
        if (!HHMM_PATTERN.test(time)) continue
        routines.push({ time, task: cleanText(match[3].trim(), 500) })
    }
    return routines
}

function routineJob(routine: HeartbeatRoutine, timeZone: string, enabled: boolean): NewJob {
    return {
        kind: ROUTINE_KIND,
        title: `Routine ${routine.time}: ${routine.task.slice(0, 60)}`,
        idKey: `heartbeat:${routine.time}|${routine.task}`,
        schedule: { type: 'taeglich', time: routine.time, timeZone },
        delivers: true,
        enabled,
        payload: { task: routine.task, time: routine.time },
        maxLateMinutes: 60,
        expiresAfterMinutes: 180,
    }
}

/** Adds one daily routine (owner command). Same text + time = same job. */
export function addRoutine(planner: Planner, routine: HeartbeatRoutine, timeZone = DEFAULT_TIME_ZONE): PlannerJob {
    if (!HHMM_PATTERN.test(routine.time)) throw new Error('Uhrzeit muss HH:MM sein')
    const task = cleanText(routine.task, 500).trim()
    if (task.length < 2) throw new Error('Aufgabe fehlt')
    return planner.addJob(routineJob({ time: routine.time, task }, timeZone, true))
}

/**
 * Moves `<legacyDir>/heartbeat.md` into planner jobs (once). The file and the
 * old execution log are renamed to `.migriert`; nothing is deleted.
 * `heartbeat.enabled=false` in the config keeps the jobs, but switched off.
 */
export function migrateHeartbeatFile(planner: Planner, options: { legacyDir: string; timeZone?: string; enabled?: boolean }): { moved: number; renamed: string | null } {
    const file = join(options.legacyDir, 'heartbeat.md')
    if (!existsSync(file)) return { moved: 0, renamed: null }
    const routines = parseHeartbeatRoutines(readFileSync(file, 'utf8'))
    for (const routine of routines) planner.addJob(routineJob(routine, options.timeZone ?? DEFAULT_TIME_ZONE, options.enabled !== false))
    const renamed = markMigrated(file)
    markMigrated(join(options.legacyDir, 'heartbeat-log.json'))
    return { moved: routines.length, renamed }
}

/** "M H * * *" (daily at H:M) → "HH:MM"; any other cron shape → null. */
export function cronToDailyTime(cron: string): string | null {
    const parts = String(cron || '').trim().split(/\s+/)
    if (parts.length !== 5 || parts.slice(2).some(part => part !== '*')) return null
    const [minute, hour] = parts
    if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    return HHMM_PATTERN.test(time) ? time : null
}

export interface AutomationPattern { id: string; action: string; userId: string; channel: string; cronExpression?: string }

/** One daily automation job per pattern id; null when the cron shape is not "M H * * *" or the action is unusable. */
export function addAutomationJob(planner: Planner, pattern: AutomationPattern, timeZone = DEFAULT_TIME_ZONE): PlannerJob | null {
    const time = cronToDailyTime(pattern.cronExpression || '')
    if (!time) return null
    const action = cleanText(pattern.action, 40).trim().toLowerCase()
    if (!/^[a-z0-9äöüß_-]{2,40}$/.test(action)) return null
    return planner.addJob({
        kind: AUTOMATION_KIND,
        title: `Automatik ${time}: ${action}`,
        idKey: `muster:${pattern.id}`,
        schedule: { type: 'taeglich', time, timeZone },
        delivers: true,
        payload: { action, time, userId: cleanText(pattern.userId, 80), channel: cleanText(pattern.channel, 40), patternId: cleanText(pattern.id, 200), cron: cleanText(pattern.cronExpression, 40) },
        maxLateMinutes: 60,
        expiresAfterMinutes: 180,
    })
}

/** Takes the automated cron patterns over (idempotent per pattern id). Unsupported cron shapes are reported, not guessed. */
export function migrateSchedulerPatterns(planner: Planner, patterns: readonly AutomationPattern[], timeZone = DEFAULT_TIME_ZONE): { moved: number; skipped: string[] } {
    let moved = 0
    const skipped: string[] = []
    for (const pattern of patterns) {
        if (!pattern?.cronExpression) continue
        const job = addAutomationJob(planner, pattern, timeZone)
        if (job) moved++
        else skipped.push(`${cleanText(pattern.action, 40)} (${cleanText(pattern.cronExpression, 40)})`)
    }
    return { moved, skipped }
}

// ---------------------------------------------------------------------------
// fixed automation actions (were in scheduler/nova-scheduler.ts)
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

async function fetchNews(fetchImpl: FetchLike): Promise<string> {
    const apiKey = process.env.NEWSAPI_KEY
    const country = process.env.NEWS_COUNTRY || 'de'
    if (!apiKey) return '📰 **Nachrichten:**\n\n_Kein API-Key konfiguriert (NEWSAPI_KEY)_'
    try {
        const response = await fetchImpl(`https://newsapi.org/v2/top-headlines?country=${encodeURIComponent(country)}&pageSize=5&apiKey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`API-Fehler ${response.status}`)
        const data = await response.json()
        if (!Array.isArray(data?.articles) || data.articles.length === 0) return '📰 **Nachrichten:**\n\n_Keine aktuellen Nachrichten gefunden._'
        const headlines = data.articles.slice(0, 5).map((a: any, i: number) => `${i + 1}. **${cleanText(a?.title, 200)}**\n   _${cleanText(a?.source?.name || 'Unbekannt', 80)}_`).join('\n\n')
        return `📰 **Top Nachrichten:**\n\n${headlines}`
    } catch (error) {
        return `📰 **Nachrichten:**\n\n_Fehler beim Abrufen: ${cleanText((error as Error)?.message || error, 120)}_`
    }
}

async function fetchWeather(fetchImpl: FetchLike): Promise<string> {
    const apiKey = process.env.OPENWEATHER_API_KEY
    const city = process.env.WEATHER_CITY || 'Berlin'
    if (!apiKey) return `🌤️ **Wetter für ${city}:**\n\n_Kein API-Key konfiguriert (OPENWEATHER_API_KEY)_`
    try {
        const response = await fetchImpl(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${encodeURIComponent(apiKey)}&units=metric&lang=de`, { signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`API-Fehler ${response.status}`)
        const data = await response.json()
        return `🌤️ **Wetter in ${city}:**\n\n• Temperatur: ${Math.round(data.main.temp)}°C (gefühlt ${Math.round(data.main.feels_like)}°C)\n• Zustand: ${cleanText(data.weather?.[0]?.description || 'unbekannt', 80)}\n• Luftfeuchtigkeit: ${data.main.humidity}%\n• Wind: ${Math.round(data.wind.speed * 3.6)} km/h`
    } catch (error) {
        return `🌤️ **Wetter:**\n\n_Fehler beim Abrufen: ${cleanText((error as Error)?.message || error, 120)}_`
    }
}

export async function runAutomationAction(action: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
    switch (action) {
        case 'news': return fetchNews(fetchImpl)
        case 'weather':
        case 'wetter': return fetchWeather(fetchImpl)
        case 'summary': return '📋 Hier ist deine tägliche Zusammenfassung.'
        case 'reminder': return '⏰ Erinnerung!'
        default: return `Aktion „${cleanText(action, 40)}“ fällig.`
    }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export interface RoutineHandlerDeps {
    /** Owner chat for routines (Telegram allowFrom / last active chat). */
    ownerChatId: () => string | undefined
    /** Wakes the pipeline with a system-authored text (reminder-tool wakePipeline). */
    wake: (userId: string, channel: string, text: string) => Promise<unknown>
    runAction?: (action: string) => Promise<string>
}

export function routineWakeText(task: string, time: string): string {
    return `[ROUTINE] Die tägliche Routine des Owners (${time}, aus seiner Routinen-Liste) ist fällig: ${JSON.stringify(task)}. Führe sie jetzt aus; Aktionen mit Außenwirkung nur nach ausdrücklicher Bestätigung.`
}

/** `routine` and `automatik` jobs; both deliver through the reminder port (kind `erinnerung`). */
export function registerRoutineHandlers(planner: Planner, deps: RoutineHandlerDeps): void {
    planner.register(ROUTINE_KIND, {
        async run(job) {
            const owner = deps.ownerChatId()
            const task = String(job.payload.task || '')
            const time = String(job.payload.time || '')
            if (!owner) return { ok: false, summary: 'kein Owner-Chat bekannt; Routine nicht gemeldet' }
            return {
                summary: `Routine ${time} fällig`,
                outgoing: { kind: 'erinnerung', title: 'Routine', text: `❤️ **Routine** (${time})\n\n${task}`, urgency: 'normal', target: { userId: owner, channel: 'Telegram' } },
            }
        },
        // Same order as before: note first, then the pipeline acts on it — only after a real delivery.
        afterDelivery: async (job, outgoing) => {
            await deps.wake(outgoing.target?.userId || '', 'Telegram', routineWakeText(String(job.payload.task || ''), String(job.payload.time || '')))
        },
    })
    planner.register(AUTOMATION_KIND, {
        async run(job) {
            const action = String(job.payload.action || '')
            const text = await (deps.runAction ?? runAutomationAction)(action)
            const userId = String(job.payload.userId || '') || deps.ownerChatId() || ''
            if (!userId) return { ok: false, summary: 'kein Empfänger' }
            return {
                summary: `Automatik ${action}`,
                outgoing: { kind: 'erinnerung', title: 'Automatik', text: `🤖 **Automatische Nachricht**\n\n${text}`, urgency: 'normal', target: { userId, channel: String(job.payload.channel || 'Telegram') } },
            }
        },
    })
}

// ---------------------------------------------------------------------------
// /routine (alias /heartbeat)
// ---------------------------------------------------------------------------

export function formatRoutines(planner: Planner | null): string {
    if (!planner) return '❤️ Routinen laufen im Planer, und der ist aus (autonomy.planner.enabled=false).'
    const jobs = planner.listJobs({ status: 'aktiv' }).filter(job => job.kind === ROUTINE_KIND || job.kind === AUTOMATION_KIND)
    if (!jobs.length) return '❤️ Keine Routinen.\n\nNeu: /routine HH:MM <Aufgabe>'
    const lines = jobs
        .sort((a, b) => String(a.payload.time || a.title).localeCompare(String(b.payload.time || b.title)))
        .map(job => `${job.enabled ? '⏳' : '💤'} ${job.title}${job.lastRunAt ? ` · zuletzt ${job.lastRunAt.slice(0, 16).replace('T', ' ')} UTC (${job.lastStatus || '?'})` : ''} · ${job.id}`)
    return `❤️ **Routinen im Planer** (${jobs.length})\n\n${lines.join('\n')}\n\n/routine HH:MM <Aufgabe> · /routine aus <id> · /routine an <id> · /routine weg <id>`
}

/** `/routine` (and the old `/heartbeat`): list, add, switch, remove. The owner check is the caller's. */
export function handleRoutineCommand(args: string, planner: Planner | null, timeZone = DEFAULT_TIME_ZONE): string {
    const text = String(args || '').trim()
    if (!planner) return formatRoutines(null)
    if (!text || ['status', 'list', 'liste'].includes(text)) return formatRoutines(planner)
    const [sub, id] = text.split(/\s+/)
    if (['aus', 'off', 'an', 'on', 'weg', 'löschen'].includes(sub)) {
        const job = id ? planner.getJob(id) : null
        if (!job || (job.kind !== ROUTINE_KIND && job.kind !== AUTOMATION_KIND)) return `❌ Keine Routine mit der ID ${cleanText(id || '?', 40)}.`
        if (sub === 'weg' || sub === 'löschen') {
            planner.completeJob(job.id, 'vom Owner entfernt')
            return `🗑️ ${job.title} entfernt.`
        }
        const on = sub === 'an' || sub === 'on'
        planner.setEnabled(job.id, on)
        return `${on ? '✅' : '💤'} ${job.title} ${on ? 'an' : 'aus'}.`
    }
    const match = /^(\d{1,2}):(\d{2})\s+(.{2,})$/.exec(text)
    if (!match) return 'Nutzung: /routine · /routine HH:MM <Aufgabe> · /routine aus|an|weg <id>'
    try {
        const job = addRoutine(planner, { time: `${match[1].padStart(2, '0')}:${match[2]}`, task: match[3] }, timeZone)
        return `❤️ Routine gespeichert: ${job.title} (${job.id})`
    } catch (error) {
        return `❌ ${(error as Error).message}`
    }
}
