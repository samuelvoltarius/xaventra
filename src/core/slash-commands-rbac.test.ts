import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
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
    it.each(['host', 'hosts'])('denies ordinary-user %s access independently of mutable owner state', async command => {
        const result = await handleCommand(command, 'new attacker 192.0.2.20 operator env:XAVENTRA_SSH_FIXTURE', 'user-1', state(), [], {
            channel: 'telegram', rawUserId: 'user-1', principalId: 'user-1', permission: 'user',
        })
        expect(result).toContain('Owner/Admin')
    })
    it('accepts host references but rejects plaintext password persistence through slash commands', async () => {
        const identity = { channel: 'telegram', rawUserId: 'owner-fixture', principalId: 'owner-fixture', permission: 'owner' as const }
        const rejected = await handleCommand('hosts', 'new fixture 192.0.2.10 operator fixture-password', 'owner-fixture', state(), [], identity)
        expect(rejected).toContain('Keine Klartext')
        expect(rejected).not.toContain('fixture-password')
        const accepted = await handleCommand('hosts', 'new fixture 192.0.2.10 operator env:XAVENTRA_SSH_FIXTURE', 'owner-fixture', state(), [], identity)
        expect(accepted).toContain('Referenz gespeichert')
        const file = join(process.cwd(), '.nova-data', 'hosts.json')
        expect(existsSync(file)).toBe(true)
        expect(JSON.parse(readFileSync(file, 'utf8')).hosts[0]).toMatchObject({ passwordEnv: 'XAVENTRA_SSH_FIXTURE' })
        expect(readFileSync(file, 'utf8')).not.toContain('fixture-password')
    })
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
