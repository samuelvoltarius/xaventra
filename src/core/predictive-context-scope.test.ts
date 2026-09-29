import { beforeEach, describe, expect, it, vi } from 'vitest'

const lance = vi.hoisted(() => ({ recall: vi.fn(async () => [] as any[]) }))
const graph = vi.hoisted(() => ({ getContextForPrompt: vi.fn(() => '') }))
vi.mock('../memory/lancedb-memory.js', () => ({ default: lance }))
vi.mock('../memory/knowledge-graph.js', () => ({ default: graph }))

const { preloadContext } = await import('./predictive-context.js')

beforeEach(() => vi.clearAllMocks())

describe('predictive context principal scoping (H7)', () => {
    it('recalls memories and graph facts only within the principal\'s scopes', async () => {
        lance.recall.mockImplementation(async () => [{ entry: { content: 'guest fact' } }])
        graph.getContextForPrompt.mockImplementation(() => 'Knowledge Graph: guest node')
        const access = { scopes: ['user:guest', 'global'], includeUnscoped: false }
        const result = await preloadContext('Erinnerst du dich an Gartenhaus Planung', 2000, access)
        expect(lance.recall).toHaveBeenCalled()
        for (const call of lance.recall.mock.calls as any[]) {
            expect(call[3]).toEqual(access)
        }
        for (const call of graph.getContextForPrompt.mock.calls as any[]) {
            expect(call[1]).toEqual(['user:guest', 'global'])
        }
        expect(result.memories).toContain('guest fact')
    })

    it('loads no personal memory at all without a principal (fail closed)', async () => {
        const result = await preloadContext('Erinnerst du dich an Gartenhaus Planung', 2000)
        expect(lance.recall).not.toHaveBeenCalled()
        expect(graph.getContextForPrompt).not.toHaveBeenCalled()
        expect(result.memories).toEqual([])
        expect(result.graphFacts).toEqual([])
    })
})
