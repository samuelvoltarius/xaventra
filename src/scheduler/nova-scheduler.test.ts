import { afterEach, describe, expect, it, vi } from 'vitest'

// MI-19: cron jobs must run in the owner's time zone, not the server's.

const cron = vi.hoisted(() => ({ schedule: vi.fn(() => ({ stop: vi.fn() })) }))
vi.mock('node-cron', () => ({ schedule: cron.schedule, default: { schedule: cron.schedule } }))
vi.mock('../learning/pattern-store.js', () => ({ getPatternStore: () => ({ getAutomatedPatterns: () => [] }) }))

import { NovaScheduler } from './nova-scheduler.js'

afterEach(() => { vi.unstubAllEnvs(); cron.schedule.mockClear() })

describe('MI-19 scheduler time zone', () => {
    it('schedules with Europe/Vienna by default', () => {
        const scheduler = new NovaScheduler()
        expect(scheduler.schedulePattern({ id: 'p-weather', action: 'weather', cronExpression: NovaScheduler.timeToCron('07:30') } as any)).toBe(true)
        expect(cron.schedule).toHaveBeenCalledWith('30 7 * * *', expect.any(Function), expect.objectContaining({ timezone: 'Europe/Vienna' }))
    })

    it('honours NOVA_TIMEZONE', () => {
        vi.stubEnv('NOVA_TIMEZONE', 'America/New_York')
        new NovaScheduler().schedulePattern({ id: 'p-news', action: 'news', cronExpression: '0 8 * * *' } as any)
        expect(cron.schedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function), expect.objectContaining({ timezone: 'America/New_York' }))
    })
})
