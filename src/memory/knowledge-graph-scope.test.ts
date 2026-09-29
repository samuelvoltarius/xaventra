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

// INT-10: the kg_search tool's searchGraph was unscoped.
describe('knowledge graph keyword search scope filtering (INT-10)', () => {
    it('hides another principal\'s nodes and relations from searchGraph', async () => {
        const { searchGraph } = await import('./knowledge-graph.js')
        const guest = searchGraph('Tresorraum Gartenhaus', 6, ['user:guest', 'global'])
        // The header line echoes the query; results are the "- <node>" lines.
        expect(guest).toContain('- Gartenhaus')
        expect(guest).not.toContain('- Tresorraum')
        expect(guest).not.toContain('contains')
        const owner = searchGraph('Tresorraum', 6, ['user:owner', 'global'])
        expect(owner).toContain('- Tresorraum')
        expect(owner).toContain('contains')
    })

    it('searches every scope only when no scope filter is given (owner)', async () => {
        const { searchGraph } = await import('./knowledge-graph.js')
        const all = searchGraph('Tresorraum Gartenhaus', 6)
        expect(all).toContain('- Tresorraum')
        expect(all).toContain('- Gartenhaus')
    })
})
