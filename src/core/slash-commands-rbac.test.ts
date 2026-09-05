import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleCommand, type DaemonState } from './slash-commands.js'
import { MemoryGovernanceCoordinator, setMemoryGovernanceCoordinator } from '../memory/memory-governance.js'

function state(): DaemonState {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {}, __userPermission: 'owner',
    }
}

describe('request-scoped slash command RBAC', () => {
    it('allows only owner/admin to start Codex OAuth', async () => {
        const result = await handleCommand('codex', 'login device', 'user-1', state(), [], {
            channel: 'telegram', rawUserId: 'user-1', principalId: 'user-1', permission: 'user',
        })
        expect(result).toContain('Owner/Admin')
    })

    it('does not trust the mutable global state permission', async () => {
        const result = await handleCommand('patch', 'list', 'guest-1', state(), [], {
            channel: 'telegram', rawUserId: 'guest-1', principalId: 'guest-1', permission: 'guest',
        })
        expect(result).toContain('owner')
    })

    it('keeps global memory governance restricted while allowing own scope', async () => {
        const governance = new MemoryGovernanceCoordinator(join(process.cwd(), '.nova-test-tmp', `rbac-${randomUUID()}`))
        setMemoryGovernanceCoordinator(governance)
        const globalCandidate = governance.propose({
            content: 'Unbestätigte globale Modellannahme für einen Test.', kind: 'context', scope: 'global',
            source: 'llm', evidence: 'model_inference', confidence: 0.5,
        })!
        const denied = await handleCommand('memory', `approve ${globalCandidate.id}`, 'user-1', state(), [], {
            channel: 'telegram', rawUserId: 'user-1', principalId: 'user-1', permission: 'user',
        })
        expect(denied).toContain('nicht gefunden')
        expect(governance.get(globalCandidate.id)?.status).toBe('candidate')

        const ownCandidate = governance.propose({
            content: 'Unbestätigte persönliche Modellannahme für einen Test.', kind: 'preference', scope: 'user:user-1',
            source: 'llm', evidence: 'model_inference', confidence: 0.5,
        })!
        await handleCommand('memory', `approve ${ownCandidate.id}`, 'user-1', state(), [], {
            channel: 'telegram', rawUserId: 'user-1', principalId: 'user-1', permission: 'user',
        })
        expect(governance.get(ownCandidate.id)?.status).toBe('canonical')
    })
})
