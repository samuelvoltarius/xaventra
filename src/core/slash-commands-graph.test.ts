import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// /graph zeigt den echten Wissensgraphen (memory/knowledge-graph.ts,
// .nova-data/knowledge-graph.json), den die Memory-Governance befüllt —
// nicht den früheren, nie befüllten intelligence/knowledge-graph.ts.
const sandbox = join(process.cwd(), '.nova-test-tmp', `graph-cmd-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data'), { recursive: true })
writeFileSync(join(sandbox, '.nova-data', 'knowledge-graph.json'), JSON.stringify({
    version: 1, lastUpdated: 1,
    nodes: [
        { id: 'alfred', label: 'Alfred', type: 'person', properties: {}, createdAt: 1, updatedAt: 1 },
        { id: 'salzburg', label: 'Salzburg', type: 'place', properties: {}, createdAt: 1, updatedAt: 1 },
    ],
    edges: [{ id: 'e1', from: 'alfred', to: 'salzburg', relation: 'wohnt_in', weight: 1, source: 'governance:mem_1', createdAt: 1 }],
}))
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { handleCommand } = await import('./slash-commands.js')
const state: any = {
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null, memory: null,
    learning: null, tools: null, resilience: null, startTime: Date.now(), config: {},
}
const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }

describe('/graph liest den Governance-Wissensgraphen', () => {
    it('zählt Knoten und Kanten aus .nova-data/knowledge-graph.json', async () => {
        const text = String(await handleCommand('graph', '', 'owner-1', state, [], owner))
        expect(text).toContain('Knoten: 2')
        expect(text).toContain('Kanten: 1')
        expect(text).toContain('place(1)')
    })
})
