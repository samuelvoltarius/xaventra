import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

const records = vi.hoisted(() => new Map<string, { status: string; scope: string }>([
    ['gov-owner', { status: 'verified', scope: 'user:owner' }],
    ['gov-guest', { status: 'verified', scope: 'user:guest' }],
]))
vi.mock('./memory-governance.js', () => ({
    getMemoryGovernanceCoordinator: () => ({ get: (id: string) => records.get(id) }),
}))

const sandbox = join(process.cwd(), '.nova-test-tmp', `graph-scope-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const graph = (await import('./knowledge-graph.js')).default

graph.addNode('Tresorraum', 'place', { governanceId: 'gov-owner', code: 'owner-secret' })
graph.addEdge('Tresorraum', 'contains', 'Festplatte', 1, 'governance:gov-owner')
graph.addNode('Gartenhaus', 'place', { governanceId: 'gov-guest', farbe: 'gruen' })

describe('knowledge graph prompt context scope filtering (H7)', () => {
    it('hides another principal\'s graph facts', () => {
        const context = graph.getContextForPrompt('Tresorraum Gartenhaus', ['user:guest', 'global'])
        expect(context).toContain('Gartenhaus')
        expect(context).not.toContain('Tresorraum')
        expect(context).not.toContain('owner-secret')
    })

    it('shows the principal\'s own facts and relations', () => {
        const context = graph.getContextForPrompt('Tresorraum', ['user:owner', 'global'])
        expect(context).toContain('owner-secret')
        expect(context).toContain('contains')
    })
})
