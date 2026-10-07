import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// logSession writes below process.cwd(); keep the fixture out of shared data.
const sandbox = join(process.cwd(), '.nova-test-tmp', `pipeline-turns-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { logSession, recentSessionTurns } = await import('./message-pipeline.js')

// 2.89: the response cache is gone; the session tail still scopes follow-up questions
// (runtime question "und das zweite?") per user and channel.
describe('session turns per user (R2 UEB-21)', () => {
    it('keeps the same follow-up question in different conversations apart', () => {
        logSession('user-a', 'Telegram', 'user', 'Nenne zwei Städte in Italien')
        logSession('user-a', 'Telegram', 'assistant', 'Rom und Mailand')
        logSession('user-a', 'Telegram', 'user', 'und das zweite?')
        logSession('user-b', 'Telegram', 'user', 'Nenne zwei Flüsse in Deutschland')
        logSession('user-b', 'Telegram', 'assistant', 'Rhein und Elbe')
        logSession('user-b', 'Telegram', 'user', 'und das zweite?')

        const a = recentSessionTurns('user-a', 'Telegram')
        const b = recentSessionTurns('user-b', 'Telegram')
        const userTurns = (messages: Array<{ role: string; content: string }>) => messages.filter(m => m.role === 'user').map(m => m.content)
        expect(userTurns(a)).toEqual(['Nenne zwei Städte in Italien', 'und das zweite?'])
        expect(userTurns(b)).toEqual(['Nenne zwei Flüsse in Deutschland', 'und das zweite?'])
    })
})
