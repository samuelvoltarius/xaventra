/**
 * 2.82.0 Aufräumen Punkt 1: EINE Ruhezeit-Definition (vorher 23–7 Schleife,
 * 22–7 Gedanken, 22–7 fest im Messenger, 22–7 Wahrnehmen).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureQuietHours, getQuietHours, isQuietHourOfDay, onQuietHoursChange, parseQuietHours, setQuietHours } from './quiet-hours.js'
import { ProactiveMessenger } from './proactive.js'
import { assessmentFromEvent } from './proactive-policy.js'
import { parsePlannerSettings } from '../planner/runtime.js'
import { getAutonomyStatus, updateAutonomyConfig } from './autonomy-loop.js'
import { parseSensingConfig } from '../sensing/config.js'

vi.spyOn(console, 'log').mockImplementation(() => undefined)
afterEach(() => { configureQuietHours(undefined); vi.useRealTimers() })

describe('eine Ruhezeit', () => {
    it('autonomy.quietHours, sonst der alte Gedanken-Schlüssel, sonst 22–7; enabled:false = aus', () => {
        expect(parseQuietHours(undefined)).toEqual({ start: 22, end: 7 })
        expect(parseQuietHours({ quietHours: { start: 23, end: 6 } })).toEqual({ start: 23, end: 6 })
        expect(parseQuietHours({ thoughts: { quietHours: { start: 21, end: 8 } } })).toEqual({ start: 21, end: 8 })
        expect(parseQuietHours({ quietHours: { start: 23 }, thoughts: { quietHours: { start: 21, end: 8 } } })).toEqual({ start: 23, end: 7 })
        expect(parseQuietHours({ quietHours: { enabled: false } })).toEqual({ start: -1, end: -1 })
        expect(isQuietHourOfDay(23, { start: 22, end: 7 })).toBe(true)
        expect(isQuietHourOfDay(12, { start: 22, end: 7 })).toBe(false)
        expect(isQuietHourOfDay(3, { start: -1, end: -1 })).toBe(false)
    })

    it('Planer-Gedanken, Schleife und Wahrnehmen lesen dieselbe Definition', () => {
        const autonomy = { quietHours: { start: 21, end: 6 } }
        configureQuietHours(autonomy)
        const planner = parsePlannerSettings(autonomy)
        expect([planner.thoughts.quietStart, planner.thoughts.quietEnd]).toEqual([21, 6])
        expect(getAutonomyStatus().config.quietHoursStart).toBe(21)
        expect(getAutonomyStatus().config.quietHoursEnd).toBe(6)
        const sensing = parseSensingConfig({}, {})
        expect([sensing.notify.quietStart, sensing.notify.quietEnd]).toEqual([21, 6])
    })

    it('/autonomy quiet ändert sie für alle (Listener, Messenger)', async () => {
        const seen: number[] = []
        const stop = onQuietHoursChange(value => seen.push(value.start))
        updateAutonomyConfig({ quietHoursStart: 0, quietHoursEnd: 23 })
        stop()
        expect(seen).toEqual([0])
        expect(getQuietHours()).toEqual({ start: 0, end: 23 })

        vi.useFakeTimers({ toFake: ['Date'] })
        const noon = new Date(); noon.setHours(12, 0, 0, 0); vi.setSystemTime(noon)
        const messenger = new ProactiveMessenger()
        const send = vi.fn(async () => true)
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })
        const msg = { userId: 'owner', channel: 'telegram' as const, content: 'x', priority: 'normal' as const, type: 'notification' as const, assessment: assessmentFromEvent({ source: 'health-monitor', summary: 'x', severity: 'warning', confidence: 0.99 }) }
        expect(await messenger.send(msg)).toBe(false) // 12:00 is inside 0–23
        setQuietHours({ start: -1, end: -1 })
        expect(await messenger.processQueue()).toBe(1)
        expect(send).toHaveBeenCalledOnce()
    })
})
