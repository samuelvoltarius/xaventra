import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSoul, saveSoul } from './soul.js'

// R2 NZ-3 (core-n-z #3): /persona is owner-only via the central role table
// (CL-03). saveSoul must not destroy a hand-written root SOUL.md without a
// backup, and an external edit must invalidate the cache.

let dir = ''

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-soul-'))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
})

afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
})

describe('soul persistence (R2 NZ-3)', () => {
    it('keeps the previous root SOUL.md as backup when saving', () => {
        const original = '# Nova\n\nSprache: Deutsch\n\n## Persönlichkeit\n\nOwner-Regeln: nie ohne Bestätigung handeln.\n'
        writeFileSync(join(dir, 'SOUL.md'), original)
        saveSoul({ name: 'X', language: 'Deutsch', personality: 'kurz', createdAt: 1, updatedAt: 1 })
        expect(readFileSync(join(dir, 'SOUL.md.bak'), 'utf-8')).toBe(original)
        expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toContain('# X')
    })

    it('reloads after an external edit of SOUL.md', () => {
        const path = join(dir, 'SOUL.md')
        writeFileSync(path, '# Alpha\n\n## Persönlichkeit\n\nerste\n')
        utimesSync(path, new Date(1_000_000), new Date(1_000_000))
        expect(loadSoul().name).toBe('Alpha')
        writeFileSync(path, '# Beta\n\n## Persönlichkeit\n\nzweite\n')
        utimesSync(path, new Date(2_000_000), new Date(2_000_000))
        expect(loadSoul().name).toBe('Beta')
    })
})

describe('system prompt device wording (R2 UEB-14)', () => {
    it('does not refer to a "Bekannte Geräte" section that only the owner prompt carries', async () => {
        const { buildSystemPromptFromSoul } = await import('./soul.js')
        const prompt = buildSystemPromptFromSoul({ name: 'Nova', language: 'Deutsch', personality: 'p', createdAt: 0, updatedAt: 0 })
        expect(prompt).not.toContain('Bekannte Geräte')
        expect(prompt).toContain('SSH-Inventar, falls vorhanden')
    })
})
