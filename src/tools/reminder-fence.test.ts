import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../core/croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule: vi.fn(async () => {}) }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: vi.fn(() => 'owner') }))

let rt: typeof import('./reminder-tool.js')
let fence: typeof import('../mesh/fence.js')
beforeEach(async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'reminder-fence-')))
    vi.resetModules()
    rt = await import('./reminder-tool.js')
    fence = await import('../mesh/fence.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const list = async () => (await rt.listRemindersTool.handler({ userId: 'owner-1', authorizationUserId: 'owner-1', channel: 'telegram' }) as any).count

describe('CL-07 (f) a reminder without a valid fence is kept, not fired and not deleted', () => {
    it('stays pending across many unfenced ticks and fires once the fenced Main delivers it', async () => {
        let fenced = true
        const notify = vi.fn(async () => {
            if (fenced) throw new fence.FenceError('telegram', 'no live Main/Telegram authority', 'reminder:notify')
        })
        const wakeup = vi.fn(async () => undefined)
        rt.setReminderNotifyCallback(notify)
        rt.setReminderWakeupCallback(wakeup)
        await rt.reminderTool.handler({ message: 'Zahnarzt', time: '1', userId: 'owner-1', channel: 'telegram' })
        vi.useFakeTimers({ now: Date.now() + 5 * 60_000, toFake: ['Date'] })

        // More ticks than MAX_NOTIFY_ATTEMPTS (5): a fence refusal is not a failed attempt.
        for (let tick = 0; tick < 8; tick++) await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(8)
        expect(wakeup).not.toHaveBeenCalled()
        expect(await list()).toBe(1)

        fenced = false
        await rt.checkAndFireReminders()
        expect(notify).toHaveBeenCalledTimes(9)
        expect(wakeup).toHaveBeenCalledTimes(1)
        expect(await list()).toBe(0)
    })
})
