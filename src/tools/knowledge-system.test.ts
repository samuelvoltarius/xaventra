import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root = ''
let ks: typeof import('./knowledge-system.js')
beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.resetModules()
    ks = await import('./knowledge-system.js')
    // Victims outside the knowledge directory
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'daemon.js'), 'build')
    mkdirSync(join(root, '.nova-data', 'secrets'), { recursive: true })
})
afterEach(() => vi.restoreAllMocks())

describe('R2 T2: knowledge_delete stays inside the knowledge directory', () => {
    it.each(['../../dist', '..\\..\\dist', '../secrets', '..', '.', '/', ''])('refuses traversal %j', async (title) => {
        const result = await ks.knowledgeDeleteTool.handler({ title })
        expect(result.success).toBe(false)
        expect(existsSync(join(root, 'dist', 'daemon.js'))).toBe(true)
        expect(existsSync(join(root, '.nova-data', 'secrets'))).toBe(true)
    })
    it('an empty slug does not delete the whole knowledge directory', async () => {
        ks.storeKnowledge('Erstes Thema', 'Inhalt')
        const result = await ks.knowledgeDeleteTool.handler({ title: '!!!' })
        expect(result.success).toBe(false)
        expect(existsSync(join(root, '.nova-data', 'knowledge', 'erstes-thema', 'content.md'))).toBe(true)
    })
    it('still deletes a real entry by title or id', async () => {
        ks.storeKnowledge('Zweites Thema', 'Inhalt')
        expect((await ks.knowledgeDeleteTool.handler({ title: 'Zweites Thema' })).success).toBe(true)
        ks.storeKnowledge('Drittes', 'Inhalt')
        expect((await ks.knowledgeDeleteTool.handler({ title: 'drittes' })).success).toBe(true)
        expect(existsSync(join(root, '.nova-data', 'knowledge', 'drittes'))).toBe(false)
    })
    it('refuses to store a title without a usable slug (would write into the root)', () => {
        expect(() => ks.storeKnowledge('ÆØÅ', 'Inhalt')).toThrow()
        expect(existsSync(join(root, '.nova-data', 'knowledge', 'content.md'))).toBe(false)
    })
    it('does not read metadata outside the knowledge directory', () => {
        writeFileSync(join(root, '.nova-data', 'metadata.json'), JSON.stringify({ id: 'x', title: 'outside', accessCount: 0 }))
        expect(ks.getKnowledge('..')).toBeNull()
    })
})
