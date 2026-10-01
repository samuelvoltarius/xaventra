import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPlanner } from './planner.js'
import { createThoughtStore } from './thoughts.js'
import { formatZoned } from './time.js'
import {
    createAutoReminders, parseAutoReminderSettings, setAutoReminders, sourceFromSensingEvent, startAutoRemindersRuntime,
} from './auto-reminders.js'
import { dispatchThoughtAnswer, rememberAutoReminderAction } from '../core/thought-hub.js'
import type { SensingEvent } from '../sensing/ports.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'p6-autorem-'))
const DAY = 24 * 60 * 60_000

function setup(start = '2026-10-01T08:00:00Z', settings: Record<string, unknown> = {}) {
    const dataDir = tmp()
    let clock = Date.parse(start)
    const now = () => clock
    const thoughts = createThoughtStore({ dataDir, now })
    const planner = createPlanner({ dataDir, now, authority: () => true })
    const engine = createAutoReminders({
        dataDir, now, planner, thoughts,
        settings: parseAutoReminderSettings({ autoReminders: { enabled: true, ...settings } }),
        rememberAction: rememberAutoReminderAction,
    })
    return { dataDir, thoughts, planner, engine, advance: (ms: number) => { clock += ms }, now }
}

function mailEvent(stichworte: string, mailText = 'GEHEIMER MAILTEXT mit Preis 12.345 Euro'): SensingEvent {
    return {
        schema: 'xaventra.sensing.event/1', id: 'ev_1', at: '2026-10-01T08:00:00Z', source: 'mail', kind: 'mail.new', subject: 'owner@imap',
        summary: `E-Mail von Max Muster (example.com) wegen Angebot: „Angebot Fassade ${mailText}“`, severity: 'warning',
        dedupeKey: 'mail:owner@imap:42',
        evidence: { konto: 'owner@imap', absender: 'max@example.com', bekannt: true, stichworte: stichworte, datum: null },
        hint: { title: 'E-Mail von Max Muster (example.com) (Angebot)', level: 'fragen' },
    }
}

describe('Auto-Erinnerungen: Standard aus, Worker nichts', () => {
    it('P8: ohne Config am Main an, am Worker aus; mit enabled:false startet nichts', async () => {
        expect(parseAutoReminderSettings({}, undefined, {} as NodeJS.ProcessEnv).enabled).toBe(true)
        expect(parseAutoReminderSettings({}, undefined, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv).enabled).toBe(false)
        expect(parseAutoReminderSettings({ autoReminders: { enabled: false } }, undefined, {} as NodeJS.ProcessEnv).enabled).toBe(false)
        const dataDir = tmp()
        const planner = createPlanner({ dataDir, authority: () => true })
        const started = await startAutoRemindersRuntime({ autoReminders: { enabled: false } }, { nodeOnly: false, planner: { planner, thoughts: createThoughtStore({ dataDir }), settings: { thoughts: { quietStart: 22, quietEnd: 7, timeZone: 'Europe/Vienna', dedupeMinutes: 360, maxPerDay: 10 } } } as any })
        expect(started.started).toBe(false)
        expect(planner.listJobs()).toHaveLength(0)
    })

    it('ein Mesh-Worker startet keine Auto-Erinnerungen', async () => {
        const dataDir = tmp()
        const planner = createPlanner({ dataDir, authority: () => true })
        const started = await startAutoRemindersRuntime({ autoReminders: { enabled: true } }, { nodeOnly: true, planner: { planner, thoughts: createThoughtStore({ dataDir }), settings: { thoughts: { quietStart: 22, quietEnd: 7, timeZone: 'Europe/Vienna', dedupeMinutes: 360, maxPerDay: 10 } } } as any })
        expect(started.started).toBe(false)
        expect(planner.listJobs()).toHaveLength(0)
    })

    it('Gegenprobe: am Main mit Planer wird der Prüf-Job angelegt', async () => {
        const dataDir = tmp()
        const planner = createPlanner({ dataDir, authority: () => true })
        const started = await startAutoRemindersRuntime({ autoReminders: { enabled: true } }, { nodeOnly: false, planner: { planner, thoughts: createThoughtStore({ dataDir }), settings: { thoughts: { quietStart: 22, quietEnd: 7, timeZone: 'Europe/Vienna', dedupeMinutes: 360, maxPerDay: 10 } } } as any })
        expect(started.started).toBe(true)
        expect(planner.getJob('sys-auto-erinnerungen')).toMatchObject({ mainOnly: true, enabled: true })
        setAutoReminders(null)
    })

    it('Planer-Jobs der Auto-Erinnerungen laufen nie auf einem Worker', async () => {
        const dataDir = tmp()
        const planner = createPlanner({ dataDir, authority: () => false })
        await startAutoRemindersRuntime({ autoReminders: { enabled: true } }, { nodeOnly: false, planner: { planner, thoughts: createThoughtStore({ dataDir }), settings: { thoughts: { quietStart: 22, quietEnd: 7, timeZone: 'Europe/Vienna', dedupeMinutes: 360, maxPerDay: 10 } } } as any })
        const report = await planner.tick()
        expect(report.executed).toHaveLength(0)
        expect(report.skippedWorker).toContain('sys-auto-erinnerungen')
        setAutoReminders(null)
    })
})

describe('Auto-Erinnerungen: Angebot', () => {
    it('Angebots-Mail → nach 5 Tagen Gedanke „fragen“, Job erst nach Ja; nie Mail-Volltext', async () => {
        const { engine, thoughts, planner, advance } = setup()
        const source = sourceFromSensingEvent(mailEvent('angebot'))
        expect(source).toMatchObject({ type: 'angebot' })
        engine.intake(source!)
        engine.evaluate()
        expect(thoughts.list({ source: 'auto-erinnerung' })).toHaveLength(0)
        advance(5 * DAY)
        const created = engine.evaluate()
        expect(created.asked).toBe(1)
        const thought = thoughts.list({ source: 'auto-erinnerung' })[0]
        expect(thought).toMatchObject({ kind: 'vorschlag', permission: 'fragen', importance: 'wichtig' })
        expect(thought.title).toMatch(/Angebot von Max Muster \(example\.com\) seit 5 Tagen unbeantwortet/)
        expect(planner.listJobs({ kind: 'auto-erinnerung' })).toHaveLength(0)
        const stored = JSON.stringify(engine.state())
        for (const text of [JSON.stringify(thought), stored]) {
            expect(text).not.toContain('GEHEIMER MAILTEXT')
            expect(text).not.toContain('Fassade')
            expect(text).not.toContain('max@example.com')
        }
        // Ja via the thought hub (as the Knopf-Karte executor does)
        setAutoReminders(engine)
        const answer = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1' })
        expect(answer.ok).toBe(true)
        const jobs = planner.listJobs({ kind: 'auto-erinnerung' })
        expect(jobs).toHaveLength(1)
        expect(jobs[0]).toMatchObject({ delivers: true, schedule: { type: 'einmal' } })
        expect(formatZoned(Date.parse(jobs[0].nextRunAt!))).toMatch(/ 09:00$/)
        // the same mail does not ask again
        engine.intake(source!)
        advance(6 * DAY)
        expect(engine.evaluate().asked).toBe(0)
        setAutoReminders(null)
    })

    it('Nein → kein Job', async () => {
        const { engine, thoughts, planner, advance } = setup()
        engine.intake(sourceFromSensingEvent(mailEvent('angebot'))!)
        advance(5 * DAY)
        engine.evaluate()
        const thought = thoughts.list({ source: 'auto-erinnerung' })[0]
        setAutoReminders(engine)
        await dispatchThoughtAnswer(thought.id, 'nein', { userId: '1' })
        expect(planner.listJobs({ kind: 'auto-erinnerung' })).toHaveLength(0)
        setAutoReminders(null)
    })

    it('Mail ohne Stichwort Angebot erzeugt keine Angebots-Regel (Gegenprobe)', () => {
        expect(sourceFromSensingEvent(mailEvent(''))).toBeNull()
    })

    it('Tageslimit: mehr als maxPerDay Vorschläge warten auf den nächsten Tag', () => {
        const { engine, advance } = setup('2026-10-01T08:00:00Z', { maxPerDay: 2 })
        for (let i = 0; i < 4; i++) engine.intake({ type: 'angebot', key: `mail:k${i}`, who: `Firma ${i}`, at: '2026-10-01T08:00:00Z' })
        advance(5 * DAY)
        expect(engine.evaluate().asked).toBe(2)
        expect(engine.evaluate().asked).toBe(0)
        advance(DAY)
        expect(engine.evaluate().asked).toBe(2)
    })
})

describe('Auto-Erinnerungen: Termin und Release', () => {
    it('Termin morgen 9:00 → Erinnerung heute 20:00 (selbst)', () => {
        const { engine, planner, thoughts } = setup('2026-10-01T08:00:00Z')
        engine.intake({ type: 'termin', key: 'cal:1', title: 'Zahnarzt', startAt: '2026-10-02T07:00:00Z' }) // 09:00 Vienna
        engine.evaluate()
        const jobs = planner.listJobs({ kind: 'auto-erinnerung' })
        expect(jobs).toHaveLength(1)
        expect(formatZoned(Date.parse(jobs[0].nextRunAt!))).toBe('01.10. 20:00')
        expect(String(jobs[0].payload.text)).toContain('Zahnarzt')
        // selbst: no question
        expect(thoughts.list({ source: 'auto-erinnerung' }).every(item => item.permission === 'selbst')).toBe(true)
    })

    it('Termin-Erinnerung respektiert die Ruhezeit', () => {
        const { engine, planner } = setup('2026-10-01T08:00:00Z', {})
        // quiet hours from 19:00: 20:00 is quiet, the reminder moves before 19:00
        const quietEngine = createAutoReminders({
            dataDir: tmp(), now: () => Date.parse('2026-10-01T08:00:00Z'), planner,
            thoughts: createThoughtStore({ dataDir: tmp() }),
            settings: parseAutoReminderSettings({ autoReminders: { enabled: true } }, { quietStart: 19, quietEnd: 7, timeZone: 'Europe/Vienna' }),
        })
        quietEngine.intake({ type: 'termin', key: 'cal:2', title: 'Arzt', startAt: '2026-10-02T07:00:00Z' })
        quietEngine.evaluate()
        const job = planner.listJobs({ kind: 'auto-erinnerung' })[0]
        const local = formatZoned(Date.parse(job.nextRunAt!))
        expect(local.startsWith('01.10.')).toBe(true)
        const hour = Number(local.slice(7, 9))
        expect(hour).toBeLessThan(19)
        expect(hour).toBeGreaterThanOrEqual(7)
        void engine
    })

    it('die Ausführung zur Ruhezeit meldet nicht, sondern legt es in den Bericht', async () => {
        const dataDir = tmp()
        let clock = Date.parse('2026-10-01T21:30:00Z') // 23:30 Vienna
        const thoughts = createThoughtStore({ dataDir, now: () => clock })
        const planner = createPlanner({ dataDir, now: () => clock, authority: () => true, ports: { default: () => ({ name: 'test', deliver: async () => ({ status: 'zugestellt' }) }) } })
        const engine = createAutoReminders({ dataDir, now: () => clock, planner, thoughts, settings: parseAutoReminderSettings({ autoReminders: { enabled: true } }) })
        engine.registerHandlers(planner)
        planner.addJob({ kind: 'auto-erinnerung', title: 'Erinnerung', schedule: { type: 'einmal', at: new Date(clock - 1000).toISOString() }, delivers: true, payload: { text: 'Termin X' } })
        const report = await planner.tick()
        expect(report.delivered).toHaveLength(0)
        expect(thoughts.list({ source: 'auto-erinnerung' })[0]?.title).toMatch(/Termin X/)
        void clock
    })

    it('unbestätigtes Release → morgen intern prüfen (selbst, ohne Zustellung)', () => {
        const { engine, planner } = setup('2026-10-01T08:00:00Z')
        engine.intake({ type: 'release', key: 'release:2.82.0', version: '2.82.0', signiert: false })
        engine.evaluate()
        const job = planner.listJobs({ kind: 'auto-pruefung' })[0]
        expect(job).toMatchObject({ delivers: false, mainOnly: true, payload: { version: '2.82.0' } })
        expect(formatZoned(Date.parse(job.nextRunAt!))).toBe('02.10. 09:00')
    })

    it('Entprellen: derselbe Termin legt nur einen Job an', () => {
        const { engine, planner } = setup()
        for (let i = 0; i < 3; i++) engine.intake({ type: 'termin', key: 'cal:dup', title: 'Zahnarzt', startAt: '2026-10-02T07:00:00Z' })
        engine.evaluate()
        engine.evaluate()
        expect(planner.listJobs({ kind: 'auto-erinnerung' })).toHaveLength(1)
    })
})
