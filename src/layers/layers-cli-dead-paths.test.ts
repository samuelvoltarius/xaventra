import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const execSync = vi.fn(() => '')
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), execSync }))

const { QAAgent } = await import('./L12-qa-agent.js')
const { MultiBotManager } = await import('./multi-bot.js')

describe('CLI/dead layer paths (R2 L20/L21)', () => {
    it('L12 QA agent refuses shell syntax in the test filter', async () => {
        const agent = new QAAgent()
        await expect(agent.runTests(process.cwd(), 'x; touch /tmp/r2-l20')).rejects.toThrow(/Invalid test filter/)
        expect(execSync.mock.calls.some(call => String((call as unknown[])[0]).includes('touch'))).toBe(false)
    })

    it('multi-bot allowlist is fail-closed when empty', () => {
        const manager = new MultiBotManager(join(process.cwd(), '.nova-data', 'r2-l21'))
        const bot = manager.createBot({ name: 'b', persona: 'p', channel: 'cli', channelConfig: {}, enabled: false, createdBy: 'test' })
        expect(manager.isUserAllowed(bot.id, 'anyone')).toBe(false)
    })
})
