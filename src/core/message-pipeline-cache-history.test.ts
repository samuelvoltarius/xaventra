import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// logSession writes below process.cwd(); keep the fixture out of shared data.
const sandbox = join(process.cwd(), '.nova-test-tmp', `pipeline-cache-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { logSession, responseCacheMessages } = await import('./message-pipeline.js')

describe('response cache key history (R2 UEB-21)', () => {
    it('distinguishes the same follow-up question in different conversations', () => {
        logSession('user-a', 'Telegram', 'user', 'Nenne zwei Städte in Italien')
        logSession('user-a', 'Telegram', 'assistant', 'Rom und Mailand')
        logSession('user-a', 'Telegram', 'user', 'und das zweite?')
        logSession('user-b', 'Telegram', 'user', 'Nenne zwei Flüsse in Deutschland')
        logSession('user-b', 'Telegram', 'assistant', 'Rhein und Elbe')
        logSession('user-b', 'Telegram', 'user', 'und das zweite?')

        const a = responseCacheMessages('user-a', 'Telegram', 'und das zweite?')
        const b = responseCacheMessages('user-b', 'Telegram', 'und das zweite?')
        const userTurns = (messages: Array<{ role: string; content: string }>) => messages.filter(m => m.role === 'user').map(m => m.content)
        expect(userTurns(a)).toEqual(['Nenne zwei Städte in Italien', 'und das zweite?'])
        expect(userTurns(b)).toEqual(['Nenne zwei Flüsse in Deutschland', 'und das zweite?'])
    })
})
