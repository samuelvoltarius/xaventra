import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// vitest.setup.ts chdirs into a temporary runtime root; the journal lives in <cwd>/.nova-data/journal.
const journalDir = join(process.cwd(), '.nova-data', 'journal')
const today = new Date().toISOString().split('T')[0]

describe('journal (R2 MA-17)', () => {
    it('keeps an unreadable day file instead of overwriting it', async () => {
        mkdirSync(journalDir, { recursive: true })
        writeFileSync(join(journalDir, `${today}.json`), '{ kaputt')
        const journal = await import('./journal.js')
        journal.recordEvent('chat', 'Hallo', undefined, '111', 'telegram')
        const aside = readdirSync(journalDir).filter(name => name.startsWith(`${today}.json.corrupt-`))
        expect(aside).toHaveLength(1)
        expect(readFileSync(join(journalDir, aside[0]), 'utf8')).toBe('{ kaputt')
    })

    it('gives the cross-user journal context only to the owner', async () => {
        const journal = await import('./journal.js')
        journal.recordEvent('chat', 'Owner fragt nach Server Atlas', undefined, '111', 'telegram')
        expect(journal.getJournalContextForPrompt('x', { permission: 'owner' })).toContain('Journal')
        expect(journal.getJournalContextForPrompt('x', { permission: 'guest' })).toBe('')
        expect(journal.getJournalContextForPrompt('x')).toBe('')
    })
})
