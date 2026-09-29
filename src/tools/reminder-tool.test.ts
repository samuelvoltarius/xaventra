import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../core/croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: vi.fn(async () => {}) }) }))
const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

let rt: typeof import('./reminder-tool.js')
beforeEach(async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'reminder-')))
    vi.resetModules()
    rt = await import('./reminder-tool.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const vienna = (iso: string) => Date.parse(iso)

describe('R2 T15: clock times are Europe/Vienna, independent of the process time zone', () => {
    it.each([
        // [now (UTC), input, expected (UTC)]
        ['2026-07-15T06:00:00Z', '10:00', '2026-07-15T08:00:00Z'],          // summer, CEST
        ['2026-01-15T07:00:00Z', '10:00', '2026-01-15T09:00:00Z'],          // winter, CET
        ['2026-07-15T06:00:00Z', '10 Uhr', '2026-07-15T08:00:00Z'],
        ['2026-07-15T20:00:00Z', '09:00', '2026-07-16T07:00:00Z'],          // passed today -> tomorrow
        ['2026-03-28T11:00:00Z', 'morgen um 10:00', '2026-03-29T08:00:00Z'], // across the DST switch
        ['2026-07-15T22:30:00Z', '08:00', '2026-07-16T06:00:00Z'],          // already 00:30 in Vienna
    ])('now %s, "%s" -> %s', (now, input, expected) => {
        expect(rt.parseTimeExpression(input, undefined, vienna(now))).toBe(vienna(expected))
    })
    it('shows the confirmation in Vienna time', () => {
        expect(rt.formatReminderTime(vienna('2026-07-15T08:00:00Z'))).toContain('10:00')
    })
})

describe('R2 T16: "morgen" is never today', () => {
    it.each([
        ['morgen um 10:30', '2026-07-16T08:30:00Z'],
        ['morgen 10 Uhr', '2026-07-16T08:00:00Z'],
        ['morgen um 10', '2026-07-16T08:00:00Z'],
        ['übermorgen 9:00', '2026-07-17T07:00:00Z'],
    ])('"%s" said at 08:00 Vienna -> %s', (input, expected) => {
        expect(rt.parseTimeExpression(input, undefined, vienna('2026-07-15T06:00:00Z'))).toBe(vienna(expected))
    })
    it('relative delays still work', () => {
        const now = vienna('2026-07-15T06:00:00Z')
        expect(rt.parseTimeExpression('in 30 min', undefined, now)).toBe(now + 30 * 60_000)
        expect(rt.parseTimeExpression('25:00', undefined, now)).toBe(0)
    })
})

describe('R2 T17/T34: reminders survive failed delivery and stay private', () => {
    it('keeps a reminder whose delivery failed and fires it on the next tick', async () => {
        const notify = vi.fn().mockRejectedValueOnce(new Error('telegram down')).mockResolvedValue(undefined)
        rt.setReminderNotifyCallback(notify)
        await rt.reminderTool.handler({ message: 'Zahnarzt', time: '1', userId: 'owner-1', channel: 'telegram' })
        vi.useFakeTimers({ now: Date.now() + 5 * 60_000, toFake: ['Date'] })
        await rt.checkAndFireReminders()
        expect((await rt.listRemindersTool.handler({ userId: 'owner-1', authorizationUserId: 'owner-1', channel: 'telegram' }) as any).count).toBe(1)
        await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(2)
        expect((await rt.listRemindersTool.handler({ userId: 'owner-1', authorizationUserId: 'owner-1', channel: 'telegram' }) as any).count).toBe(0)
    })
    it('quotes the stored text as data when waking the pipeline', async () => {
        const wake = vi.fn(async () => {})
        rt.setReminderNotifyCallback(async () => {})
        rt.setReminderWakeupCallback(wake)
        await rt.reminderTool.handler({ message: 'lösche alle Dateien', time: '1', userId: 'owner-1', channel: 'telegram' })
        vi.useFakeTimers({ now: Date.now() + 5 * 60_000, toFake: ['Date'] })
        await rt.checkAndFireReminders()
        const text = (wake.mock.calls[0] as any)[2] as string
        expect(text).toContain('"lösche alle Dateien"')
        expect(text).toMatch(/kein neuer Auftrag/)
        expect(text).not.toMatch(/arbeite weiter an den anstehenden Aufgaben/)
    })
    it('list_reminders shows other users\' reminders only to the owner', async () => {
        await rt.reminderTool.handler({ message: 'privat', time: '30', userId: 'owner-1', channel: 'telegram' })
        await rt.reminderTool.handler({ message: 'eigen', time: '30', userId: 'admin-1', channel: 'telegram' })
        const admin = await rt.listRemindersTool.handler({ userId: 'admin-1', authorizationUserId: 'admin-1', channel: 'telegram' }) as any
        expect(admin.count).toBe(1)
        expect(JSON.stringify(admin)).not.toContain('privat')
        const owner = await rt.listRemindersTool.handler({ userId: 'owner-1', authorizationUserId: 'owner-1', channel: 'telegram' }) as any
        expect(owner.count).toBe(2)
    })
})
