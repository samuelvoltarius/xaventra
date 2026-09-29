import { describe, expect, it, vi } from 'vitest'

// Keep the real .nova-data untouched: no reads of existing state, no writes.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: () => false, writeFileSync: vi.fn(), mkdirSync: vi.fn() }
})

import { getInsightEngine, getMemoryConsolidator } from './autonomy-engine.js'

describe('R2 L4: global insights and consolidation reach owner prompts only', () => {
    it('does not inject insights into a guest prompt and keeps them for the owner', () => {
        const engine = getInsightEngine()
        engine.recordInsight('observation', 'Gespräch mit Nutzer A: private Details')

        expect(engine.buildInsightPromptBlock({ permission: 'guest' })).toBeNull()
        expect(engine.buildInsightPromptBlock()).toBeNull()

        const ownerBlock = engine.buildInsightPromptBlock({ permission: 'owner' })
        expect(ownerBlock).toContain('private Details')
    })

    it('does not inject the weekly journal summary into non-owner prompts', () => {
        const consolidator = getMemoryConsolidator() as any
        consolidator.consolidations = [{ period: 'KW 39', summary: 'Chat mit user-b: Arzttermin', consolidatedFrom: 3, consolidatedTo: 1, createdAt: Date.now() }]

        expect(consolidator.getConsolidationContext({ permission: 'user' })).toBeNull()
        expect(consolidator.getConsolidationContext()).toBeNull()
        expect(consolidator.getConsolidationContext({ permission: 'owner' })).toContain('Arzttermin')
    })
})
