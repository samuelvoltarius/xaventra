import { describe, expect, it } from 'vitest'
import { getCommandMinimumRole, handleCommand, type DaemonState } from './slash-commands.js'

// R2 core-n-z #1, #3, #6, #7, #22, #42: the commands the second review found
// without role checks are owner-only through the central table (CL-03).
// This pins that so a later table edit cannot silently reopen them.

function state(): DaemonState {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {}, __userPermission: 'owner',
    }
}

const commands = ['preflight', 'persona', 'task', 'log', 'logs', 'world', 'worldmodel', 'lagebild', 'update']

describe('R2 role findings stay owner-only', () => {
    it.each(commands)('/%s requires owner', command => {
        expect(getCommandMinimumRole(command)).toBe('owner')
    })

    it.each(['guest', 'user', 'admin'] as const)('denies all of them to %s', async permission => {
        for (const command of commands) {
            const result = await handleCommand(command, 'history', `${permission}-1`, state(), [],
                { channel: 'telegram', rawUserId: `${permission}-1`, principalId: `${permission}-1`, permission } as any)
            expect(result, command).toContain('🔒')
        }
    })
})
