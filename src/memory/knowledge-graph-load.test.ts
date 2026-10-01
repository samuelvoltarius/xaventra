import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('./memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => ({ get: () => undefined }) }))

// Governance projiziert auch in Prozessen ohne initKnowledgeGraph() (CLI,
// Tests). Der erste Schreibzugriff darf die vorhandene Datei nie ersetzen.
const sandbox = join(process.cwd(), '.nova-test-tmp', `graph-load-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
const file = join(sandbox, '.nova-data', 'knowledge-graph.json')
writeFileSync(file, JSON.stringify({
    version: 1, lastUpdated: 1, edges: [],
    nodes: [{ id: 'salzburg', label: 'Salzburg', type: 'place', properties: {}, createdAt: 1, updatedAt: 1 }],
}))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())
const graph = await import('./knowledge-graph.js')

describe('Wissensgraph lädt vor dem ersten Schreiben', () => {
    it('behält vorhandene Knoten, wenn ohne Init ein neuer dazukommt', () => {
        graph.addNode('Werkstatt', 'place', { governanceId: 'mem_x' })
        const saved = JSON.parse(readFileSync(file, 'utf-8'))
        expect(saved.nodes.map((node: any) => node.label).sort()).toEqual(['Salzburg', 'Werkstatt'])
        expect(graph.getStats().nodes).toBe(2)
    })
})
