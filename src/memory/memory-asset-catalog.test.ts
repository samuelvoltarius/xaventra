import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MemoryAssetCatalog } from './memory-asset-catalog.js'

describe('memory asset catalog', () => {
    it('keeps private assets owner-scoped and resolves only active loadouts', () => {
        const catalog = new MemoryAssetCatalog(join(mkdtempSync(join(tmpdir(), 'nova-assets-')), 'assets.json'))
        const draft = catalog.create('sample', { name: 'Draft', kind: 'wiki', content: 'Ungeprüft', status: 'draft' })
        const active = catalog.create('sample', { name: 'Release Wissen', kind: 'skill', content: 'Canary vor Rollout', status: 'active' })
        catalog.bind('sample', 'room', 'release-room', draft.id)
        catalog.bind('sample', 'room', 'release-room', active.id)
        expect(catalog.list('sample')).toHaveLength(2)
        expect(catalog.list('other', 'other')).toHaveLength(0)
        expect(catalog.resolve('sample', [{ type: 'room', id: 'release-room' }]).map(item => item.id)).toEqual([active.id])
    })

    it('builds a bounded prompt loadout with provenance metadata', () => {
        const catalog = new MemoryAssetCatalog(join(mkdtempSync(join(tmpdir(), 'nova-assets-')), 'assets.json'))
        const asset = catalog.create('sample', { name: 'Nova Architektur', kind: 'wiki', content: 'Ein Execution Kernel ist autoritativ.', status: 'active' })
        const context = catalog.promptContext([asset], 500)
        expect(context).toContain('Memory-Asset-Loadout')
        expect(context).toContain('wiki · v1 · active')
        expect(context.length).toBeLessThan(500)
    })
})
