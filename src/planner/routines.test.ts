import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: vi.fn(async () => {}), cancel: vi.fn(async () => true) }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: vi.fn(() => 'owner') }))

let rt: typeof import('../tools/reminder-tool.js')
let runtime: typeof import('./runtime.js')
let routines: typeof import('./routines.js')
let cwd: string
let t: number
const previousState = (globalThis as any).__novaState

beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'planner-routines-'))
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.resetModules()
    rt = await import('../tools/reminder-tool.js')
    runtime = await import('./runtime.js')
    routines = await import('./routines.js')
    // 07:00 in Vienna (CEST)
    t = Date.parse('2026-10-01T05:00:00.000Z')
    ;(globalThis as any).__novaState = { config: { channels: { telegram: { allowFrom: ['4242'] } } } }
})
afterEach(() => {
    runtime.stopPlannerRuntime()
    ;(globalThis as any).__novaState = previousState
    vi.restoreAllMocks()
})

const dataDir = () => join(cwd, '.nova-data')
const start = (planner: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    runtime.startPlannerRuntime({ planner }, { dataDir: dataDir(), now: () => t, authority: () => true, startTimer: false, patterns: () => [], ...extra })

function writeHeartbeat(content: string): string {
    mkdirSync(dataDir(), { recursive: true })
    const file = join(dataDir(), 'heartbeat.md')
    writeFileSync(file, content)
    return file
}

describe('P9 ein Zeitplaner: Standard und Quelltext', () => {
    it('Erinnerungen laufen standardmäßig über den Planer; false ist der Rückweg; ein Worker bekommt kein AN', () => {
        expect(runtime.parsePlannerSettings({}, {} as NodeJS.ProcessEnv).reminders).toBe(true)
        expect(runtime.parsePlannerSettings({ planner: { reminders: false } }, {} as NodeJS.ProcessEnv).reminders).toBe(false)
        expect(runtime.parsePlannerSettings({}, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv).reminders).toBe(false)
    })

    it('keine eigenen Zeitplaner mehr: heartbeat.ts, nova-scheduler.ts weg; die Schleife liest kein reminders.json', () => {
        const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
        expect(existsSync(here('../core/heartbeat.ts'))).toBe(false)
        expect(existsSync(here('../scheduler/nova-scheduler.ts'))).toBe(false)
        expect(readFileSync(here('../core/autonomy-loop.ts'), 'utf8')).not.toMatch(/reminders\.json/)
        const daemon = readFileSync(here('../daemon.ts'), 'utf8')
        expect(daemon).not.toMatch(/initHeartbeat/)
        expect(daemon).not.toMatch(/nova-scheduler/)
        expect(readFileSync(here('../core/daemon-channels.ts'), 'utf8')).not.toMatch(/setHeartbeat/)
    })
})

describe('P9 heartbeat.md → Planer-Routinen', () => {
    it('übernimmt die Routinen genau einmal und benennt die Datei in .migriert um', async () => {
        const file = writeHeartbeat('# Nova Heartbeat\n# Format: HH:MM | Task\n08:00 | Postfach prüfen\n7:30 | Wetter ansehen\nkaputt\n25:00 | ungültig\n')
        const first = await start()
        const jobs = first!.planner.listJobs({ kind: 'routine' })
        expect(jobs.map(job => job.payload.time).sort()).toEqual(['07:30', '08:00'])
        expect(jobs.every(job => job.delivers && job.enabled && job.schedule.type === 'taeglich')).toBe(true)
        expect(existsSync(file)).toBe(false)
        expect(readFileSync(`${file}.migriert`, 'utf8')).toContain('Postfach prüfen')

        runtime.stopPlannerRuntime()
        const second = await start()
        expect(second!.planner.listJobs({ kind: 'routine' })).toHaveLength(2)
    })

    it('heartbeat.enabled=false übernimmt die Routinen ausgeschaltet', async () => {
        writeHeartbeat('08:00 | Postfach prüfen\n')
        const handle = await start({}, { heartbeatEnabled: false })
        expect(handle!.planner.listJobs({ kind: 'routine' })[0].enabled).toBe(false)
    })

    it('eine fällige Routine wird genau einmal gemeldet und weckt danach die Pipeline — auch über einen Neustart', async () => {
        writeHeartbeat('08:00 | Postfach prüfen\n')
        const notify = vi.fn(async () => undefined)
        const wakeup = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(wakeup)
        const handle = await start()
        await handle!.planner.tick()
        expect(notify).not.toHaveBeenCalled()

        t = Date.parse('2026-10-01T06:01:00.000Z')
        await handle!.planner.tick()
        await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith('4242', 'Telegram', '❤️ **Routine** (08:00)\n\nPostfach prüfen')
        expect(wakeup).toHaveBeenCalledTimes(1)
        expect(String((wakeup.mock.calls[0] as unknown[])[2])).toMatch(/^\[ROUTINE\]/)

        runtime.stopPlannerRuntime()
        const again = await start()
        await again!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
        // next day again, exactly once
        t = Date.parse('2026-10-02T06:01:00.000Z')
        await again!.planner.tick()
        await again!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(2)
    })

    it('/routine legt an, schaltet aus und entfernt', async () => {
        const handle = await start()
        const planner = handle!.planner
        expect(routines.handleRoutineCommand('09:15 Zeitung lesen', planner)).toMatch(/Routine gespeichert/)
        const [job] = planner.listJobs({ kind: 'routine' })
        expect(job.payload).toMatchObject({ time: '09:15', task: 'Zeitung lesen' })
        expect(routines.handleRoutineCommand(`aus ${job.id}`, planner)).toMatch(/aus\./)
        expect(planner.getJob(job.id)!.enabled).toBe(false)
        expect(routines.handleRoutineCommand(`weg ${job.id}`, planner)).toMatch(/entfernt/)
        expect(planner.listJobs({ kind: 'routine', status: 'aktiv' })).toHaveLength(0)
        expect(routines.handleRoutineCommand('aus job-000000000000', planner)).toMatch(/Keine Routine/)
        expect(routines.handleRoutineCommand('irgendwas', planner)).toMatch(/Nutzung/)
    })
})

describe('P9 reminders.json → Planer (keine Doppel-Zustellung)', () => {
    it('benennt reminders.json in .migriert um; der alte Prüfer stellt nichts mehr zu, der Planer genau einmal', async () => {
        mkdirSync(dataDir(), { recursive: true })
        const file = join(dataDir(), 'reminders.json')
        writeFileSync(file, JSON.stringify([
            { id: 'rem_1', message: 'Alt', triggerAt: t - 60_000, userId: 'owner-1', channel: 'telegram', createdAt: t - 120_000, fired: false },
        ]))
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        await rt.initReminders()
        const handle = await start({ reminders: true })
        expect(existsSync(file)).toBe(false)
        expect(JSON.parse(readFileSync(`${file}.migriert`, 'utf8'))).toHaveLength(1)
        expect(handle!.planner.listJobs({ kind: 'erinnerung' })).toHaveLength(1)

        await rt.checkAndFireReminders()
        expect(notify).not.toHaveBeenCalled()
        await handle!.planner.tick()
        await rt.checkAndFireReminders()
        await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
    })

    it('Gegenprobe Rückweg: Planer aus → reminders.json bleibt und der alte Prüfer stellt zu', async () => {
        mkdirSync(dataDir(), { recursive: true })
        const file = join(dataDir(), 'reminders.json')
        writeFileSync(file, JSON.stringify([
            { id: 'rem_2', message: 'Rückweg', triggerAt: Date.now() - 60_000, userId: 'owner-1', channel: 'telegram', createdAt: Date.now() - 120_000, fired: false },
        ]))
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        await rt.initReminders()
        expect(await start({ enabled: false }, {})).toBeNull()
        expect(existsSync(file)).toBe(true)
        await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(1)
    })
})

describe('P9 node-cron-Muster → Planer-Automatik', () => {
    it('übernimmt tägliche Muster idempotent und meldet andere Formen, statt zu raten', async () => {
        const patterns = [
            { id: 'u:tg:news', action: 'news', userId: 'owner-1', channel: 'telegram', cronExpression: '30 7 * * *' },
            { id: 'u:tg:weather', action: 'weather', userId: 'owner-1', channel: 'telegram', cronExpression: '*/5 * * * *' },
        ]
        const first = await start({}, { patterns: () => patterns })
        const jobs = first!.planner.listJobs({ kind: 'automatik' })
        expect(jobs).toHaveLength(1)
        expect(jobs[0].schedule).toMatchObject({ type: 'taeglich', time: '07:30' })
        runtime.stopPlannerRuntime()
        const second = await start({}, { patterns: () => patterns })
        expect(second!.planner.listJobs({ kind: 'automatik' })).toHaveLength(1)
        expect(routines.cronToDailyTime('0 8 * * *')).toBe('08:00')
        expect(routines.cronToDailyTime('0 8 * * 1')).toBeNull()
        expect(routines.cronToDailyTime('61 8 * * *')).toBeNull()
    })

    it('eine fällige Automatik liefert das Ergebnis genau einmal an den Musterbesitzer', async () => {
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        const handle = await start({}, { patterns: () => [{ id: 'p1', action: 'summary', userId: 'owner-1', channel: 'telegram', cronExpression: '0 8 * * *' }] })
        t = Date.parse('2026-10-01T06:00:30.000Z')
        await handle!.planner.tick()
        await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
        expect((notify.mock.calls[0] as unknown[])[0]).toBe('owner-1')
        expect(String((notify.mock.calls[0] as unknown[])[2])).toContain('tägliche Zusammenfassung')
    })
})
