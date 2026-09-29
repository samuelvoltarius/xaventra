import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProactiveMessenger, type ProactiveMessage } from './proactive.js'
import { assessmentFromEvent } from './proactive-policy.js'

// R2 core-n-z #10, #12, #13 (proactive delivery):
// - sender.send() === false is not a success (no budget, no dedupe block),
// - quiet hours / budget defer instead of dropping, alarms are not swallowed,
// - a channel that connects later receives the deferred messages.

vi.spyOn(console, 'log').mockImplementation(() => undefined)

afterEach(() => {
    vi.useRealTimers()
})

function alert(content = 'Dienst X ist down'): ProactiveMessage {
    return {
        userId: 'owner', channel: 'telegram', content, priority: 'high', type: 'error',
        assessment: assessmentFromEvent({ source: 'service-monitor', summary: content, severity: 'error', confidence: 0.98, dedupeKey: `service:${content}` }),
    }
}

function atHour(hour: number): void {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date()
    now.setHours(hour, 10, 0, 0)
    vi.setSystemTime(now)
}

describe('send() === false is not delivered (R2 NZ-13)', () => {
    it('does not count or dedupe a refused send, so the retry goes out', async () => {
        atHour(12)
        const messenger = new ProactiveMessenger()
        const send = vi.fn(async () => false)
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })

        expect(await messenger.send(alert())).toBe(false)
        expect(messenger.getStats().sentToday).toBe(0)

        send.mockResolvedValue(true)
        expect(await messenger.send(alert())).toBe(true)
        expect(messenger.getStats().sentToday).toBe(1)
        expect(send).toHaveBeenCalledTimes(2)
    })
})

describe('quiet hours defer instead of dropping (R2 NZ-12)', () => {
    it('queues a night-time alert and delivers it after quiet hours', async () => {
        atHour(23)
        const messenger = new ProactiveMessenger({ quietHoursStart: 22, quietHoursEnd: 7 })
        const send = vi.fn(async () => true)
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })

        expect(await messenger.send(alert())).toBe(false)
        expect(send).not.toHaveBeenCalled()
        expect(messenger.getStats().queueLength).toBe(1)

        atHour(8)
        expect(await messenger.processQueue()).toBe(1)
        expect(send).toHaveBeenCalledOnce()
        expect(messenger.getStats().queueLength).toBe(0)
    })

    it('delivers a user alarm inside quiet hours', async () => {
        atHour(6)
        const messenger = new ProactiveMessenger({ quietHoursStart: 22, quietHoursEnd: 7 })
        const send = vi.fn(async () => true)
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })
        expect(await messenger.sendAlarm('owner', 'telegram', 'Wecker 06:10')).toBe(true)
        expect(send).toHaveBeenCalledOnce()
    })

    it('defers over the daily budget instead of dropping', async () => {
        atHour(12)
        const messenger = new ProactiveMessenger({ dailyBudget: 1 })
        const send = vi.fn(async () => true)
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })
        expect(await messenger.send(alert('A'))).toBe(true)
        expect(await messenger.send(alert('B'))).toBe(false)
        expect(messenger.getStats().queueLength).toBe(1)
    })
})

describe('channel connecting after boot (R2 NZ-10)', () => {
    it('keeps alerts while Telegram is disconnected and delivers after reconnect', async () => {
        atHour(12)
        const messenger = new ProactiveMessenger()
        let connected = false
        const send = vi.fn(async () => true)
        messenger.registerChannel({ name: 'telegram', isConnected: () => connected, send })

        expect(await messenger.send(alert())).toBe(false)
        expect(messenger.getStats().queueLength).toBe(1)

        connected = true
        expect(await messenger.processQueue()).toBe(1)
        expect(send).toHaveBeenCalledOnce()
    })
})
