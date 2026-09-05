import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AutoObserver } from './auto-observer.js'
import { MemoryGovernanceCoordinator, setMemoryGovernanceCoordinator } from './memory-governance.js'

describe('observer and memory governance integration', () => {
    it('makes a direct user fact available across the next prompt immediately', async () => {
        const root = join(process.cwd(), '.nova-test-tmp', `observer-governance-${randomUUID()}`)
        const governance = new MemoryGovernanceCoordinator(join(root, 'governance'))
        setMemoryGovernanceCoordinator(governance)
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })

        const facts = await observer.observe('42', 'My name is Example User', 'user', 'telegram-session-1')
        const context = governance.getContextForPrompt('user:42', 'What is my name?')

        expect(facts.some(fact => fact.governanceId)).toBe(true)
        expect(context).toContain('Example User')
        expect(context).toContain('VERIFIZIERT')
    })

    it('does not promote assistant inference into trusted memory', async () => {
        const root = join(process.cwd(), '.nova-test-tmp', `observer-governance-${randomUUID()}`)
        const governance = new MemoryGovernanceCoordinator(join(root, 'governance'))
        setMemoryGovernanceCoordinator(governance)
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })

        await observer.observe('42', 'I prefer local models for all important production workloads', 'assistant', 'session-2')

        expect(governance.getStats().candidate).toBeGreaterThanOrEqual(1)
        expect(governance.getContextForPrompt('user:42', 'local models')).toBe('')
        expect(observer.getContextForPrompt('42', 'local models')).toBe('')
    })

    it('remembers a natural relationship fact without an explicit memory command', async () => {
        const root = join(process.cwd(), '.nova-test-tmp', `observer-governance-${randomUUID()}`)
        const governance = new MemoryGovernanceCoordinator(join(root, 'governance'))
        setMemoryGovernanceCoordinator(governance)
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })

        const facts = await observer.observe('42', 'Mein Hund heißt Bello.', 'user', 'telegram-session-3')
        const context = governance.getContextForPrompt('user:42', 'Wie heißt mein Hund?')

        expect(facts).toHaveLength(1)
        expect(facts[0]).toMatchObject({ type: 'relationship' })
        expect(context).toContain('Bello')
        expect(context).toContain('VERIFIZIERT')
    })
})
