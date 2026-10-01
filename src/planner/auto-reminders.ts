/**
 * Proaktive Erinnerungen aus Quellen (Autonomie-Plan Phase 6e, Dots-Parität).
 *
 * Fixed rules turn observations into planner jobs. No model decides here.
 *
 * | Rule | Source | Stufe | Result |
 * |------|--------|-------|--------|
 * | Angebot unbeantwortet | mail.new with keyword "angebot" (Wahrnehmen-Bus) | fragen | after `offerDays` (5): thought "Angebot von X seit 5 Tagen unbeantwortet — morgen 09:00 nachfragen?"; the reminder job is created only after Ja |
 * | Rechnung | mail.new with keyword "rechnung" | fragen | after `invoiceDays` (7): "… morgen 09:00 an die Zahlung erinnern?", job after Ja |
 * | Termin | calendar.event / kalender.termin with evidence.start | selbst | reminder on the evening before at `eveningTime` (20:00) for morning appointments, else 2 h before; moved out of quiet hours |
 * | Release unbestätigt | self-update thought `update-rejected` (Release-Wächter) | selbst, intern | job tomorrow at `followUpTime` that re-checks read-only; result as a thought, nothing is delivered |
 * | Mission wartet | `noteMissionWaiting()` (missions) | fragen | after `missionWaitHours` (24): "Mission … wartet auf dich — morgen 09:00 erinnern?" |
 *
 * Guarantees:
 * - Each source key is handled once (Entprellen); a daily limit (`maxPerDay`)
 *   caps questions and self-created jobs; the rest waits for the next day.
 * - Never mail text: only the sender label (name + domain) from the event
 *   title and the keyword. No subject, no address, no body is stored.
 * - "unbeantwortet" means: no reply was seen. The sent folder is not read
 *   (mail is read-only, inbox only); the owner closes it with Nein.
 * - Jobs are created by code (ids by the planner); the thought hub maps a
 *   button press to `accept`/`decline` of a code-generated plan id only.
 * - Off until `autonomy.autoReminders.enabled=true`; needs the planner; a mesh
 *   worker never runs it (planner jobs are mainOnly).
 *
 * File: `<data>/auto-reminders/state.json`.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { cleanText } from './delivery-port.js'
import type { JobHandler, Planner } from './planner.js'
import type { PlannerRuntime } from './runtime.js'
import { isQuietHour, type ThoughtSettings, type ThoughtStore } from './thoughts.js'
import { DEFAULT_TIME_ZONE, HHMM_PATTERN, formatZoned, isValidTimeZone, zonedDay, zonedHour, zonedWallTime } from './time.js'

export type ReminderSource =
    | { type: 'angebot'; key: string; who: string; at: string }
    | { type: 'rechnung'; key: string; who: string; at: string }
    | { type: 'termin'; key: string; title: string; startAt: string }
    | { type: 'release'; key: string; version: string; signiert: boolean }
    | { type: 'mission-wartet'; key: string; missionId: string; title: string; since: string }

export interface AutoReminderSettings {
    enabled: boolean
    offerDays: number
    invoiceDays: number
    missionWaitHours: number
    followUpTime: string
    eveningTime: string
    maxPerDay: number
    quietStart: number
    quietEnd: number
    timeZone: string
}

export type PlanStatus = 'gefragt' | 'geplant' | 'abgelehnt'
export interface ReminderPlan {
    id: string
    rule: ReminderSource['type']
    key: string
    title: string
    text: string
    status: PlanStatus
    thoughtId?: string
    jobId?: string
    at?: string
    createdAt: string
    decidedAt?: string
}

interface State {
    version: 1
    pending: ReminderSource[]
    done: Record<string, string>
    plans: Record<string, ReminderPlan>
    counter: { day: string; count: number }
}

export const PLAN_ID_PATTERN = /^ar-[a-f0-9]{12}$/
export const AUTO_REMINDER_JOB_ID = 'sys-auto-erinnerungen'
const SOURCE = 'auto-erinnerung'
const DAY_MS = 24 * 60 * 60_000
const MAX_PENDING = 200
const DONE_RETENTION_MS = 60 * DAY_MS

export function parseAutoReminderSettings(autonomy: any, thoughts?: Partial<Pick<ThoughtSettings, 'quietStart' | 'quietEnd' | 'timeZone'>>): AutoReminderSettings {
    const raw = autonomy?.autoReminders ?? {}
    const int = (value: unknown, fallback: number, min: number, max: number) =>
        Number.isFinite(Number(value)) && Number(value) >= min ? Math.min(max, Math.floor(Number(value))) : fallback
    const hhmm = (value: unknown, fallback: string) => typeof value === 'string' && HHMM_PATTERN.test(value) ? value : fallback
    const hour = (value: unknown, fallback: number) => Number.isInteger(value) && (value as number) >= -1 && (value as number) <= 23 ? value as number : fallback
    const timeZone = typeof thoughts?.timeZone === 'string' && isValidTimeZone(thoughts.timeZone) ? thoughts.timeZone : DEFAULT_TIME_ZONE
    return {
        enabled: raw.enabled === true,
        offerDays: int(raw.offerDays, 5, 1, 60),
        invoiceDays: int(raw.invoiceDays, 7, 1, 60),
        missionWaitHours: int(raw.missionWaitHours, 24, 1, 24 * 14),
        followUpTime: hhmm(raw.followUpTime, '09:00'),
        eveningTime: hhmm(raw.eveningTime, '20:00'),
        maxPerDay: int(raw.maxPerDay, 5, 1, 50),
        quietStart: hour(thoughts?.quietStart, 22),
        quietEnd: hour(thoughts?.quietEnd, 7),
        timeZone,
    }
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

const KEY = (value: unknown) => cleanText(value, 200).trim()

/** Sender label from the event title ("E-Mail von Max (example.com) (Angebot)") — never the subject or text. */
function senderLabel(title: unknown): string {
    const text = cleanText(title, 200).replace(/^E-Mail von\s+/i, '').replace(/\s*\((?:[^()]*?(?:Angebot|Rechnung|Termin|Nachricht)[^()]*)\)\s*$/i, '').trim()
    return text.replace(/[\w.+-]+@[\w.-]+/g, '').trim().slice(0, 80) || 'unbekannt'
}

/** Maps a Wahrnehmen event to a reminder source (null = no rule applies). */
export function sourceFromSensingEvent(event: { kind?: string; dedupeKey?: string; at?: string; summary?: string; subject?: string; evidence?: Record<string, unknown>; hint?: { title?: string } }): ReminderSource | null {
    if (!event || typeof event.kind !== 'string') return null
    if (event.kind === 'mail.new') {
        const words = String(event.evidence?.stichworte ?? '').toLowerCase().split(',').map(item => item.trim())
        const type = words.includes('angebot') ? 'angebot' : words.includes('rechnung') ? 'rechnung' : null
        if (!type || !event.dedupeKey) return null
        const at = Number.isFinite(Date.parse(String(event.at))) ? new Date(Date.parse(String(event.at))).toISOString() : new Date().toISOString()
        return { type, key: KEY(`${type}:${event.dedupeKey}`), who: senderLabel(event.hint?.title), at }
    }
    if (event.kind === 'calendar.event' || event.kind === 'kalender.termin') {
        const start = Date.parse(String(event.evidence?.start ?? ''))
        if (!Number.isFinite(start) || !event.dedupeKey) return null
        return { type: 'termin', key: KEY(`termin:${event.dedupeKey}:${start}`), title: cleanText(event.evidence?.titel ?? event.subject ?? 'Termin', 80), startAt: new Date(start).toISOString() }
    }
    return null
}

/** Release-Wächter: an unconfirmed (rejected) release is re-checked tomorrow. */
export function sourceFromSelfUpdateThought(thought: { kind?: string; title?: string; text?: string }): ReminderSource | null {
    if (thought?.kind !== 'update-rejected') return null
    const version = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(`${thought.title || ''} ${thought.text || ''}`)?.[1]
    if (!version) return null
    return { type: 'release', key: `release:${version}`, version, signiert: false }
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

export interface AutoRemindersDeps {
    dataDir?: string
    now?: () => number
    planner: Pick<Planner, 'addJob' | 'listJobs'> & Partial<Pick<Planner, 'register'>>
    thoughts: Pick<ThoughtStore, 'add'>
    settings: AutoReminderSettings
    /** Remembers which plan a thought's button belongs to (thought hub). */
    rememberAction?: (thoughtId: string, planId: string) => void
    /** Read-only re-check for an unconfirmed release. */
    releaseCheck?: (version: string) => Promise<{ ok: boolean; detail: string }>
}

export interface AutoReminders {
    intake(source: ReminderSource): boolean
    intakeEvent(event: Parameters<typeof sourceFromSensingEvent>[0]): boolean
    evaluate(): { asked: number; planned: number; waiting: number }
    accept(planId: string, by: string): { ok: boolean; message: string }
    decline(planId: string, by: string): { ok: boolean; message: string }
    registerHandlers(planner: Pick<Planner, 'register'>): void
    state(): State
}

export function createAutoReminders(deps: AutoRemindersDeps): AutoReminders {
    const now = deps.now ?? Date.now
    const settings = deps.settings
    const dir = join(deps.dataDir ?? getNovaDataDir(), 'auto-reminders')
    const file = join(dir, 'state.json')
    const iso = (t = now()) => new Date(t).toISOString()
    const quiet = { quietStart: settings.quietStart, quietEnd: settings.quietEnd, timeZone: settings.timeZone }

    const load = (): State => {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            if (raw?.version === 1) return { version: 1, pending: Array.isArray(raw.pending) ? raw.pending : [], done: raw.done || {}, plans: raw.plans || {}, counter: raw.counter || { day: '', count: 0 } }
        } catch { /* fresh */ }
        return { version: 1, pending: [], done: {}, plans: {}, counter: { day: '', count: 0 } }
    }
    const save = (state: State) => {
        const cutoff = now() - DONE_RETENTION_MS
        state.done = Object.fromEntries(Object.entries(state.done).filter(([, at]) => Date.parse(at) >= cutoff))
        const plans = Object.values(state.plans).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300)
        state.plans = Object.fromEntries(plans.map(plan => [plan.id, plan]))
        state.pending = state.pending.slice(-MAX_PENDING)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        atomicWriteJsonSync(file, state)
    }
    const budgetLeft = (state: State): boolean => {
        const day = zonedDay(now(), settings.timeZone)
        if (state.counter.day !== day) state.counter = { day, count: 0 }
        return state.counter.count < settings.maxPerDay
    }
    const spend = (state: State) => { state.counter.count++ }

    /** First slot at/after `candidate` that is outside quiet hours; search back first (a reminder should come early), then forward until `latest`. */
    const placeOutsideQuiet = (candidate: number, latest: number): number | null => {
        const step = 30 * 60_000
        const earliest = now() + 5 * 60_000
        let t = Math.max(candidate, earliest)
        if (!isQuietHour(t, quiet)) return t <= latest ? t : null
        for (let back = t - step; back >= earliest && back > t - DAY_MS; back -= step) if (!isQuietHour(back, quiet)) return back
        for (let forward = t + step; forward <= latest; forward += step) if (!isQuietHour(forward, quiet)) return forward
        return null
    }
    const nextFollowUp = (dayOffset: number): number => {
        const [h, m] = settings.followUpTime.split(':').map(Number)
        const slot = zonedWallTime(now(), dayOffset, h, m, settings.timeZone)
        return placeOutsideQuiet(slot, slot + DAY_MS) ?? slot
    }

    const addPlannedJob = (state: State, plan: ReminderPlan, at: number, kind: 'auto-erinnerung' | 'auto-pruefung', payload: Record<string, unknown>) => {
        const job = deps.planner.addJob({
            kind, title: plan.title, idKey: `auto-reminder:${plan.id}`,
            schedule: { type: 'einmal', at: new Date(at).toISOString() },
            delivers: kind === 'auto-erinnerung', mainOnly: true, payload: { planId: plan.id, ...payload },
            ...(kind === 'auto-erinnerung' ? { expiresAfterMinutes: 12 * 60 } : {}),
        })
        plan.jobId = job.id
        plan.at = new Date(at).toISOString()
        plan.status = 'geplant'
        state.plans[plan.id] = plan
    }

    const newPlan = (source: ReminderSource, title: string, text: string): ReminderPlan => ({
        id: `ar-${randomBytes(6).toString('hex')}`, rule: source.type, key: source.key, title: cleanText(title, 160), text: cleanText(text, 300), status: 'gefragt', createdAt: iso(),
    })

    const ask = (state: State, source: ReminderSource, title: string, evidence: string, proposal: string, text: string) => {
        const plan = newPlan(source, title, text)
        const { thought } = deps.thoughts.add({
            source: SOURCE, kind: 'vorschlag', permission: 'fragen', title, evidence, proposal, signature: `${SOURCE}:${source.key}`,
        })
        plan.thoughtId = thought.id
        state.plans[plan.id] = plan
        try { deps.rememberAction?.(thought.id, plan.id) } catch (error) {
            console.warn(`[Auto-Erinnerungen] Knopf-Zuordnung nicht gespeichert: ${cleanText((error as Error)?.message, 120)}`)
        }
    }

    /** Applies one source. Returns 'done' (handled), 'wait' (not due yet / budget) or 'skip' (rule does not apply). */
    const apply = (state: State, source: ReminderSource): 'done' | 'wait' | 'skip' => {
        const t = now()
        const tomorrow = settings.followUpTime
        if (source.type === 'angebot' || source.type === 'rechnung' || source.type === 'mission-wartet') {
            const since = Date.parse(source.type === 'mission-wartet' ? source.since : source.at)
            if (!Number.isFinite(since)) return 'skip'
            const dueMs = source.type === 'angebot' ? settings.offerDays * DAY_MS : source.type === 'rechnung' ? settings.invoiceDays * DAY_MS : settings.missionWaitHours * 60 * 60_000
            if (t - since < dueMs) return 'wait'
            if (!budgetLeft(state)) return 'wait'
            const days = Math.floor((t - since) / DAY_MS)
            if (source.type === 'angebot') {
                ask(state, source,
                    `Angebot von ${source.who} seit ${days} Tagen unbeantwortet — morgen ${tomorrow} nachfragen?`,
                    `Quelle: E-Mail-Sensor (nur Absender + Stichwort, kein Text) · eingegangen ${formatZoned(since, settings.timeZone)} · keine Antwort gesehen (Gesendet-Ordner wird nicht gelesen)`,
                    `Erinnerung ${tomorrow}: beim Angebot von ${source.who} nachfragen`,
                    `Nachfragen: Angebot von ${source.who} (seit ${days} Tagen ohne Antwort gesehen).`)
            } else if (source.type === 'rechnung') {
                ask(state, source,
                    `Rechnung von ${source.who} vor ${days} Tagen — morgen ${tomorrow} an die Zahlung erinnern?`,
                    `Quelle: E-Mail-Sensor (nur Absender + Stichwort, kein Text) · eingegangen ${formatZoned(since, settings.timeZone)}`,
                    `Erinnerung ${tomorrow}: Rechnung von ${source.who} prüfen/bezahlen`,
                    `Rechnung von ${source.who} prüfen bzw. bezahlen.`)
            } else {
                const hours = Math.floor((t - since) / (60 * 60_000))
                ask(state, source,
                    `Mission „${source.title}“ wartet seit ${hours} h auf dich — morgen ${tomorrow} erinnern?`,
                    `Quelle: Missionen · wartet seit ${formatZoned(since, settings.timeZone)} · Mission ${source.missionId}`,
                    `Erinnerung ${tomorrow}: Mission „${source.title}“`,
                    `Mission „${source.title}“ wartet auf deine Antwort.`)
            }
            spend(state)
            return 'done'
        }
        if (source.type === 'termin') {
            const start = Date.parse(source.startAt)
            if (!Number.isFinite(start) || start - t < 30 * 60_000) return 'skip'
            if (!budgetLeft(state)) return 'wait'
            const [eh, em] = settings.eveningTime.split(':').map(Number)
            const candidate = zonedHour(start, settings.timeZone) < 12
                ? zonedWallTime(start, -1, eh, em, settings.timeZone)
                : start - 2 * 60 * 60_000
            const at = placeOutsideQuiet(candidate, start - 15 * 60_000)
            if (at === null) return 'skip'
            const plan = newPlan(source, `Erinnerung: ${source.title}`, `Erinnerung: ${source.title} am ${formatZoned(start, settings.timeZone)}.`)
            addPlannedJob(state, plan, at, 'auto-erinnerung', { text: plan.text })
            deps.thoughts.add({ source: SOURCE, kind: 'ereignis', permission: 'selbst', title: `Erinnerung an „${source.title}“ geplant für ${formatZoned(at, settings.timeZone)}`, evidence: `Termin ${formatZoned(start, settings.timeZone)} · Regel: Vorabend ${settings.eveningTime} bzw. 2 h vorher, außerhalb der Ruhezeit`, signature: `${SOURCE}:${source.key}` })
            spend(state)
            return 'done'
        }
        if (source.type === 'release') {
            if (source.signiert) return 'skip'
            if (!budgetLeft(state)) return 'wait'
            const plan = newPlan(source, `Release ${source.version}: Signatur prüfen`, `Release ${source.version} erneut lesend prüfen.`)
            addPlannedJob(state, plan, nextFollowUp(1), 'auto-pruefung', { version: source.version })
            spend(state)
            return 'done'
        }
        return 'skip'
    }

    const engine: AutoReminders = {
        intake(source) {
            if (!source || !source.key) return false
            const state = load()
            if (state.done[source.key] || state.pending.some(item => item.key === source.key)) return false
            state.pending.push(source)
            save(state)
            return true
        },
        intakeEvent(event) {
            const source = sourceFromSensingEvent(event)
            return source ? engine.intake(source) : false
        },
        evaluate() {
            const state = load()
            const result = { asked: 0, planned: 0, waiting: 0 }
            const keep: ReminderSource[] = []
            for (const source of state.pending) {
                const before = Object.keys(state.plans).length
                const outcome = apply(state, source)
                if (outcome === 'wait') { keep.push(source); result.waiting++; continue }
                state.done[source.key] = iso()
                if (outcome === 'done' && Object.keys(state.plans).length > before) {
                    const plan = Object.values(state.plans).find(item => item.key === source.key)
                    if (plan?.status === 'gefragt') result.asked++
                    else result.planned++
                }
            }
            state.pending = keep
            save(state)
            return result
        },
        accept(planId, by) {
            if (!PLAN_ID_PATTERN.test(String(planId))) return { ok: false, message: 'Unbekannter Erinnerungs-Vorschlag.' }
            const state = load()
            const plan = state.plans[planId]
            if (!plan || plan.status !== 'gefragt') return { ok: false, message: 'Vorschlag nicht mehr offen.' }
            const at = nextFollowUp(zonedHour(now(), settings.timeZone) < Number(settings.followUpTime.slice(0, 2)) ? 0 : 1)
            addPlannedJob(state, plan, at, 'auto-erinnerung', { text: plan.text })
            plan.decidedAt = iso()
            save(state)
            return { ok: true, message: `Erinnerung geplant für ${formatZoned(at, settings.timeZone)} (${cleanText(by, 40)}).` }
        },
        decline(planId) {
            if (!PLAN_ID_PATTERN.test(String(planId))) return { ok: false, message: 'Unbekannter Erinnerungs-Vorschlag.' }
            const state = load()
            const plan = state.plans[planId]
            if (!plan || plan.status !== 'gefragt') return { ok: false, message: 'Vorschlag nicht mehr offen.' }
            plan.status = 'abgelehnt'
            plan.decidedAt = iso()
            save(state)
            return { ok: true, message: 'Keine Erinnerung.' }
        },
        registerHandlers(planner) {
            const reminder: JobHandler = {
                async run(job, ctx) {
                    const text = cleanText(job.payload?.text ?? job.title, 300)
                    if (isQuietHour(ctx.now, quiet)) {
                        deps.thoughts.add({ source: SOURCE, kind: 'ereignis', permission: 'selbst', title: text, evidence: 'Ruhezeit: nicht gemeldet, steht im nächsten Bericht', signature: `${SOURCE}:ruhezeit:${job.id}` })
                        return { summary: 'Ruhezeit: in den Bericht gelegt' }
                    }
                    return { summary: 'Erinnerung fällig', outgoing: { kind: 'job', title: 'Erinnerung', text: `⏰ ${text}`, urgency: 'normal' } }
                },
            }
            const check: JobHandler = {
                async run(job) {
                    const version = cleanText(job.payload?.version, 40)
                    if (!deps.releaseCheck) {
                        deps.thoughts.add({ source: SOURCE, kind: 'ereignis', permission: 'selbst', title: `Release ${version}: Prüfung nicht verdrahtet`, evidence: 'kein lesender Release-Prüfer konfiguriert', signature: `${SOURCE}:release-check:${version}` })
                        return { ok: false, summary: 'kein Release-Prüfer' }
                    }
                    let result: { ok: boolean; detail: string }
                    try { result = await deps.releaseCheck(version) } catch (error) { result = { ok: false, detail: cleanText((error as Error)?.message, 160) } }
                    deps.thoughts.add({
                        source: SOURCE, kind: 'ereignis', permission: 'selbst',
                        title: `Release ${version}: ${result.ok ? 'vorhanden und geprüft' : 'weiter unbestätigt'}`,
                        evidence: cleanText(result.detail, 300), severity: result.ok ? 'info' : 'warning', signature: `${SOURCE}:release-check:${version}`,
                    })
                    return { ok: true, summary: result.ok ? 'Release bestätigt' : 'Release weiter unbestätigt' }
                },
            }
            const sweep: JobHandler = {
                async run() {
                    const result = engine.evaluate()
                    return { summary: `${result.asked} gefragt, ${result.planned} geplant, ${result.waiting} wartend` }
                },
            }
            planner.register('auto-erinnerung', reminder)
            planner.register('auto-pruefung', check)
            planner.register('auto-erinnerungen', sweep)
        },
        state() { return load() },
    }
    return engine
}

// ---------------------------------------------------------------------------
// runtime (daemon) + module API
// ---------------------------------------------------------------------------

let current: AutoReminders | null = null

export function getAutoReminders(): AutoReminders | null { return current }
export function setAutoReminders(engine: AutoReminders | null): void { current = engine }

/** Button answers from the thought hub (plan ids only, generated by code). */
export function acceptAutoReminderPlan(planId: string, by: string): { ok: boolean; message: string } {
    return current ? current.accept(planId, by) : { ok: false, message: 'Auto-Erinnerungen sind aus.' }
}
export function declineAutoReminderPlan(planId: string, by: string): { ok: boolean; message: string } {
    return current ? current.decline(planId, by) : { ok: true, message: 'Verworfen.' }
}

/** Missions call this when a mission waits for the owner. No-op while off. */
export function noteMissionWaiting(input: { missionId: string; title: string; since?: string }): boolean {
    if (!current || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(String(input?.missionId))) return false
    const since = input.since && Number.isFinite(Date.parse(input.since)) ? new Date(Date.parse(input.since)).toISOString() : new Date().toISOString()
    return current.intake({ type: 'mission-wartet', key: `mission:${input.missionId}:${since.slice(0, 13)}`, missionId: input.missionId, title: cleanText(input.title, 80), since })
}

/** Release-Wächter thoughts (self-update sink). No-op while off. */
export function noteSelfUpdateThought(thought: { kind?: string; title?: string; text?: string }): boolean {
    const source = current ? sourceFromSelfUpdateThought(thought) : null
    return source ? current!.intake(source) : false
}

/** Wraps the sensing event sink: every event still goes to `base`; matching ones feed the rules. */
export function createAutoReminderEventSink<T extends { writeEvent(event: any): void | Promise<void> }>(base: T): { writeEvent(event: any): Promise<void> } {
    return {
        async writeEvent(event) {
            await base.writeEvent(event)
            try { current?.intakeEvent(event) } catch (error) {
                console.warn(`[Auto-Erinnerungen] Ereignis nicht übernommen: ${cleanText((error as Error)?.message, 120)}`)
            }
        },
    }
}

export async function startAutoRemindersRuntime(autonomy: unknown, options: {
    nodeOnly: boolean
    planner?: Pick<PlannerRuntime, 'planner' | 'thoughts' | 'settings'> | null
    releaseCheck?: (version: string) => Promise<{ ok: boolean; detail: string }>
}): Promise<{ started: boolean; reason: string }> {
    current = null
    const runtime = options.planner !== undefined ? options.planner : (await import('./runtime.js')).getPlannerRuntime()
    const settings = parseAutoReminderSettings(autonomy, runtime?.settings?.thoughts)
    if (!settings.enabled) {
        // Rückweg: the sweep job stops when the switch goes off.
        if (runtime?.planner.getJob(AUTO_REMINDER_JOB_ID)) runtime.planner.setEnabled(AUTO_REMINDER_JOB_ID, false)
        return { started: false, reason: 'autonomy.autoReminders.enabled=false' }
    }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: Auto-Erinnerungen nur am Main' }
    if (!runtime) return { started: false, reason: 'Planer aus (autonomy.planner.enabled=false)' }
    const { rememberAutoReminderAction } = await import('../core/thought-hub.js')
    const engine = createAutoReminders({
        planner: runtime.planner, thoughts: runtime.thoughts, settings,
        rememberAction: rememberAutoReminderAction, releaseCheck: options.releaseCheck,
    })
    engine.registerHandlers(runtime.planner)
    runtime.planner.upsertSystemJob({ id: AUTO_REMINDER_JOB_ID, kind: 'auto-erinnerungen', title: 'Auto-Erinnerungen prüfen', schedule: { type: 'intervall', minutes: 30 }, mainOnly: true, enabled: true })
    current = engine
    return { started: true, reason: `Angebot ${settings.offerDays} T, Rechnung ${settings.invoiceDays} T, Mission ${settings.missionWaitHours} h, max. ${settings.maxPerDay}/Tag` }
}
