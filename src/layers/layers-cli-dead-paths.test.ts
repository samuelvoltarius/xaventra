import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const execSync = vi.fn(() => '')
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), execSync }))

const { QAAgent } = await import('./L12-qa-agent.js')

describe('CLI/dead layer paths (R2 L20/L21)', () => {
    it('L12 QA agent refuses shell syntax in the test filter', async () => {
        const agent = new QAAgent()
        await expect(agent.runTests(process.cwd(), 'x; touch /tmp/r2-l20')).rejects.toThrow(/Invalid test filter/)
        expect(execSync.mock.calls.some(call => String((call as unknown[])[0]).includes('touch'))).toBe(false)
    })
})
