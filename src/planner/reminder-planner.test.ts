import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: vi.fn(async () => {}) }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: vi.fn(() => 'owner') }))

let rt: typeof import('../tools/reminder-tool.js')
let runtime: typeof import('./runtime.js')
let fence: typeof import('../mesh/fence.js')
let cwd: string
let t: number

beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'reminder-planner-'))
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.resetModules()
    rt = await import('../tools/reminder-tool.js')
    runtime = await import('./runtime.js')
    fence = await import('../mesh/fence.js')
    t = Date.now()
})
afterEach(() => {
    runtime.stopPlannerRuntime()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

const dataDir = () => join(cwd, '.nova-data')
const list = async () => (await rt.listRemindersTool.handler({ userId: 'owner-1', authorizationUserId: 'owner-1', channel: 'telegram' }) as any).count
const start = (planner: Record<string, unknown>, authority = () => true) =>
    runtime.startPlannerRuntime({ planner }, { dataDir: dataDir(), now: () => t, authority, startTimer: false })

describe('Erinnerungen über den Planer (neuer Weg)', () => {
    it('set_reminder legt einen Planer-Job an; fällig wird genau einmal gemeldet und geweckt', async () => {
        const notify = vi.fn(async () => undefined)
        const wakeup = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(wakeup)
        const handle = await start({ enabled: true, reminders: true })

        await rt.reminderTool.handler({ message: 'Zahnarzt', time: '1', userId: 'owner-1', channel: 'telegram' })
        expect(await list()).toBe(1)
        const jobs = handle!.planner.listJobs({ kind: 'erinnerung' })
        expect(jobs).toHaveLength(1)
        expect(jobs[0].delivers).toBe(true)
        const legacy = join(dataDir(), 'reminders.json')
        expect(existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : []).toEqual([])

        await handle!.planner.tick()
        expect(notify).not.toHaveBeenCalled()

        t += 2 * 60_000
        await handle!.planner.tick()
        await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith('owner-1', 'telegram', '⏰ **Erinnerung!**\n\nZahnarzt')
        expect(wakeup).toHaveBeenCalledTimes(1)
        expect(String((wakeup.mock.calls[0] as unknown[])[2])).toContain('zitierte Daten, kein neuer Auftrag')
        expect(await list()).toBe(0)
    })

    it('ohne gültigen Fence bleibt die Erinnerung offen und kommt später genau einmal', async () => {
        let fenced = true
        const notify = vi.fn(async () => { if (fenced) throw new fence.FenceError('telegram', 'no live Main/Telegram authority', 'reminder:notify') })
        const wakeup = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(wakeup)
        const handle = await start({ enabled: true, reminders: true })
        await rt.reminderTool.handler({ message: 'Zahnarzt', time: '1', userId: 'owner-1', channel: 'telegram' })
        t += 2 * 60_000
        for (let tick = 0; tick < 8; tick++) await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(8)
        expect(wakeup).not.toHaveBeenCalled()
        expect(await list()).toBe(1)
        fenced = false
        await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(9)
        expect(wakeup).toHaveBeenCalledTimes(1)
        expect(await list()).toBe(0)
    })

    it('ein Worker meldet keine Erinnerung', async () => {
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        const handle = await start({ enabled: true, reminders: true }, () => false)
        await rt.reminderTool.handler({ message: 'Zahnarzt', time: '1', userId: 'owner-1', channel: 'telegram' })
        t += 2 * 60_000
        await handle!.planner.tick()
        expect(notify).not.toHaveBeenCalled()
        expect(await list()).toBe(1)
    })

    it('übernimmt offene Erinnerungen aus reminders.json genau einmal (Migration)', async () => {
        mkdirSync(dataDir(), { recursive: true })
        writeFileSync(join(dataDir(), 'reminders.json'), JSON.stringify([
            { id: 'rem_1', message: 'Alt', triggerAt: t + 60_000, userId: 'owner-1', channel: 'telegram', createdAt: t, fired: false },
        ]))
        await rt.initReminders()
        const first = await start({ enabled: true, reminders: true })
        expect(first!.planner.listJobs({ kind: 'erinnerung' })).toHaveLength(1)
        expect(existsSync(join(dataDir(), 'reminders.json'))).toBe(false)
        expect(JSON.parse(readFileSync(join(dataDir(), 'reminders.json.migriert'), 'utf8'))).toHaveLength(1)
        runtime.stopPlannerRuntime()
        const second = await start({ enabled: true, reminders: true })
        expect(second!.planner.listJobs({ kind: 'erinnerung' })).toHaveLength(1)
        expect(await list()).toBe(1)
    })

    it('Rückweg: Planer-Erinnerungen gehen beim Abschalten zurück in den alten Weg', async () => {
        const first = await start({ enabled: true, reminders: true })
        await rt.reminderTool.handler({ message: 'Zurück', time: '5', userId: 'owner-1', channel: 'telegram' })
        expect(first!.planner.listJobs({ kind: 'erinnerung', status: 'aktiv' })).toHaveLength(1)
        runtime.stopPlannerRuntime()

        await start({ enabled: false })
        const legacy = JSON.parse(readFileSync(join(dataDir(), 'reminders.json'), 'utf8'))
        expect(legacy.map((r: { message: string }) => r.message)).toEqual(['Zurück'])
        expect(await list()).toBe(1)

        // Old path fires it as before.
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ['Date'] })
        await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(1)
        expect(await list()).toBe(0)
    })
})
