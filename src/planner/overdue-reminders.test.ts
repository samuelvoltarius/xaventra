import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.82.0 (DOPPELUNGEN „Vor dem Rollout“ Punkt 5): the autonomy loop's
// "N überfällige Erinnerung(en)!" report never reached Telegram (untrusted
// source). Beleg, dass dabei keine Erinnerung verloren geht: an overdue
// reminder (e.g. due while the daemon was down) is delivered exactly once by
// the reminder path itself — through the planner when autonomy.planner.reminders
// is on, through the old reminders.json checker otherwise.

vi.mock('../core/croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: vi.fn(async () => {}) }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: vi.fn(() => 'owner') }))

let rt: typeof import('../tools/reminder-tool.js')
let runtime: typeof import('./runtime.js')
let cwd: string
let t: number

beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'overdue-reminder-'))
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.resetModules()
    rt = await import('../tools/reminder-tool.js')
    runtime = await import('./runtime.js')
    t = Date.now()
    mkdirSync(join(cwd, '.nova-data'), { recursive: true })
    writeFileSync(join(cwd, '.nova-data', 'reminders.json'), JSON.stringify([
        { id: 'rem_overdue', message: 'Zahnarzt', triggerAt: t - 3 * 60 * 60_000, userId: 'owner-1', channel: 'telegram', createdAt: t - 24 * 60 * 60_000, fired: false },
    ]))
})
afterEach(() => {
    runtime.stopPlannerRuntime()
    vi.restoreAllMocks()
})

describe('overdue reminders arrive without the autonomy report', () => {
    it('planner path: an overdue reminder is delivered on the first tick, exactly once', async () => {
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(vi.fn(async () => undefined))
        await rt.initReminders()
        const handle = await runtime.startPlannerRuntime({ planner: { enabled: true, reminders: true } }, { dataDir: join(cwd, '.nova-data'), now: () => t, authority: () => true, startTimer: false })
        for (let tick = 0; tick < 3; tick++) await handle!.planner.tick()
        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith('owner-1', 'telegram', expect.stringContaining('Zahnarzt'))
    })

    it('old path (planner reminders explicitly off): the reminder checker delivers it, exactly once', async () => {
        const notify = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(vi.fn(async () => undefined))
        await rt.initReminders()
        await runtime.startPlannerRuntime({ planner: { enabled: true, reminders: false } }, { dataDir: join(cwd, '.nova-data'), now: () => t, authority: () => true, startTimer: false })
        await rt.checkAndFireReminders()
        await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(1)
        expect(notify).toHaveBeenCalledWith('owner-1', 'telegram', expect.stringContaining('Zahnarzt'))
    })
})
