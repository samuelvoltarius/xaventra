import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const governance = vi.hoisted(() => ({ record: vi.fn(async (proposal: any) => ({ id: 'mem', ...proposal })) }))
vi.mock('../memory/memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => governance }))
vi.mock('../memory/journal.js', () => ({
    getTodayEntry: () => null,
    getRecentEntries: () => [],
    recordEvent: () => undefined,
}))

const date = '2026-09-28'
const sandbox = join(process.cwd(), '.nova-test-tmp', `distiller-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data', 'sessions'), { recursive: true })
writeFileSync(join(sandbox, 'xaventra.config.json'), JSON.stringify({
    channels: { telegram: { allowFrom: ['111'] } },
    userAliases: { '111': 'Sample', '222': 'Gast' },
    userPrincipals: { 'telegram:111': 'sample' },
}))
const line = (role: string, content: string) => JSON.stringify({ ts: `${date}T10:00:00.000Z`, channel: 'telegram', role, content })
writeFileSync(join(sandbox, '.nova-data', 'sessions', 'Sample.jsonl'), [
    line('user', 'Ich baue gerade einen Cyberdeck mit einem Raspberry Pi 5.'),
    line('assistant', 'Klingt gut.'),
].join('\n') + '\n')
writeFileSync(join(sandbox, '.nova-data', 'sessions', 'Gast.jsonl'), [
    line('user', 'Ich wohne in Linz und fahre gerne Rennrad am Wochenende.'),
].join('\n') + '\n')

const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { runDistillation } = await import('./memory-distiller.js')

function llm() {
    return {
        complete: vi.fn(async (prompt: string) => {
            const guest = prompt.includes('Linz')
            return JSON.stringify({
                userFacts: [guest
                    ? 'Der Gast wohnt in Linz und fährt am Wochenende gerne Rennrad.'
                    : 'Der Benutzer baut ein Cyberdeck mit einem Raspberry Pi 5.'],
                decisions: [],
                learnings: [guest
                    ? 'Rennradtouren rund um Linz sind am Wochenende besonders beliebt.'
                    : 'Ein Raspberry Pi 5 eignet sich gut als Basis für ein Cyberdeck.'],
                openQuestions: [], mistakes: [], mood: 'ruhig', diaryText: 'Ein ruhiger Tag.',
            })
        }),
    }
}

beforeEach(() => governance.record.mockClear())

describe('memory distiller principal scoping (H9)', () => {
    it('distills each principal separately and never merges users into one transcript', async () => {
        const model = llm()
        await runDistillation(model, date)
        expect(model.complete).toHaveBeenCalledTimes(2)
        for (const [prompt] of model.complete.mock.calls as any[]) {
            const hasOwner = prompt.includes('Cyberdeck')
            const hasGuest = prompt.includes('Linz')
            expect(hasOwner !== hasGuest).toBe(true)
        }
    })

    it('writes each principal\'s facts into that principal\'s scope and nothing into global', async () => {
        await runDistillation(llm(), date)
        const proposals = governance.record.mock.calls.map(call => call[0] as any)
        expect(proposals.length).toBeGreaterThan(0)
        expect(proposals.map(proposal => proposal.scope)).not.toContain('global')
        for (const proposal of proposals) {
            if (/Linz/.test(proposal.content)) expect(proposal.scope).toBe('user:222')
            else expect(proposal.scope).toBe('user:sample')
        }
        expect(proposals.some(proposal => proposal.scope === 'user:222')).toBe(true)
        expect(proposals.some(proposal => proposal.scope === 'user:sample')).toBe(true)
    })
})

describe('session log to principal mapping', () => {
    it('resolves aliases and channel-bound principals, and refuses ambiguous attribution', async () => {
        const { sessionLinePrincipal } = await import('./memory-distiller.js')
        const config = {
            userAliases: { '111': 'Sample', 'd-9': 'Sample', '333': 'Twin', '444': 'Twin' },
            userPrincipals: { 'telegram:111': 'sample', 'discord:d-9': 'sample' },
        }
        expect(sessionLinePrincipal(config, 'Sample', 'telegram')).toBe('sample')
        expect(sessionLinePrincipal(config, 'unaliased-7', 'telegram')).toBe('unaliased-7')
        expect(sessionLinePrincipal(config, 'Twin', 'telegram')).toBeNull()
    })
})
