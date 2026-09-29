import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { SelfRepairEngine } from './L0-self-repair.js'
import { trackSession, flushAllSessions } from './L6-session-summary.js'

describe('bounded in-memory layer state (R2 L13/L17)', () => {
    afterEach(() => vi.restoreAllMocks())

    it('L0 self-repair keeps a bounded issue list during an error loop', () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const engine = new SelfRepairEngine(join(process.cwd(), '.nova-data'))
        for (let i = 0; i < 700; i++) engine.detectIssue(new Error(`loop ${i}`))
        expect(engine.getStats().totalIssues).toBeLessThanOrEqual(500)
    })

    it('L6 session summary keeps a bounded set of pending sessions', async () => {
        const logs: string[] = []
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
        for (let i = 0; i < 80; i++) trackSession(`r2-l13-user-${i}`, 'test', [{ role: 'user', content: 'hi' }])
        await flushAllSessions()
        const line = logs.find(entry => entry.includes('Flushing'))
        expect(line).toBeDefined()
        expect(Number(line!.match(/Flushing (\d+)/)![1])).toBeLessThanOrEqual(50)
    })
})
