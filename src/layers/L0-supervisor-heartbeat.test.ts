import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHeartbeat, stopHeartbeat, saveScheduledTasks } from './L0-supervisor.js'

describe('L0 heartbeat periodic callback (R2 L3)', () => {
    afterEach(() => {
        stopHeartbeat()
        vi.useRealTimers()
    })

    it('runs the heartbeat callback on ticks without any scheduled task', async () => {
        vi.useFakeTimers()
        saveScheduledTasks([])
        const seen: string[] = []
        startHeartbeat(async task => { seen.push(task.channel) }, 1000)
        await vi.advanceTimersByTimeAsync(3100)
        expect(seen.length).toBe(3)
        expect(seen.every(channel => channel === 'heartbeat')).toBe(true)
    })

    it('does not add a pseudo tick when a real task was due', async () => {
        vi.useFakeTimers()
        saveScheduledTasks([{
            id: 't1', userId: 'u', channel: 'Telegram', description: 'x',
            scheduledFor: Date.now() - 1000, completed: false,
        }])
        const seen: string[] = []
        startHeartbeat(async task => { seen.push(task.id) }, 1000)
        await vi.advanceTimersByTimeAsync(1100)
        expect(seen).toEqual(['t1'])
        saveScheduledTasks([])
    })
})
