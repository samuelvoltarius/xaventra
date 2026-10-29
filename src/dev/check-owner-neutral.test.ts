import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ownerNameLeaks, scanOwnerNeutral } from './check-owner-neutral.js'
import { _resetOwnerProfileCacheForTest, normalizeOwnerProfile, ownerName, ownerNameAtStart, profilePath } from '../memory/owner-profile.js'

// Datenschutz (Alfred 29.10.: „wenn jemand anderer sie installiert, bekommt er dann auch meine
// Antworten?“): a fresh installation must never address its owner with a fixed name.

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('no fixed owner name in runtime text', () => {
    it('the repository runtime code names no fixed owner', () => {
        expect(scanOwnerNeutral(root).map(leak => `${leak.path}:${leak.line}`)).toEqual([])
    })

    it('flags strings, templates and regexes, never comments, and allows the persisted status id', () => {
        const source = [
            '// Alfred 29.10.: provenance comments stay',
            "const a = 'Frag Alfred einmal'",
            'const b = `wartet auf Alfred: ${x}`',
            "const c = 'wartet-auf-alfred'",
            '/** Alfred */ const d = /alfred/i',
        ].join('\n')
        expect(ownerNameLeaks('x.ts', source).map(leak => leak.line)).toEqual([2, 3, 5])
    })
})

describe('ownerName — the configured owner, else neutral', () => {
    it('a neutral installation says „der Owner“ in every case', () => {
        expect([ownerName('nom', null), ownerName('akk', null), ownerName('dat', null), ownerName('gen', null)])
            .toEqual(['der Owner', 'den Owner', 'dem Owner', 'des Owners'])
        expect(ownerNameAtStart('nom', null)).toBe('Der Owner')
    })

    it('a configured profile is named by its first name (genitive included)', () => {
        const max = normalizeOwnerProfile({ version: 1, owner: { name: 'Max Muster' } })
        expect([ownerName('nom', max), ownerName('akk', max), ownerName('gen', max)]).toEqual(['Max', 'Max', 'Max’'])
        expect(ownerName('gen', normalizeOwnerProfile({ version: 1, owner: { name: 'Hans Beispiel' } }))).toBe('Hans’')
    })

    it('runtime texts follow the profile of this installation', async () => {
        const { agentDesktopInputPauseReason, holdAgentDesktopInput } = await import('../desktop-direct/pause.js')
        const release = holdAgentDesktopInput('h1', 'desk-1')
        try {
            _resetOwnerProfileCacheForTest()
            const neutral = agentDesktopInputPauseReason()!
            expect(neutral).not.toMatch(/Alfred/)
            expect(neutral).toContain('der Owner hat den Desktop übernommen')

            mkdirSync(join(profilePath(), '..'), { recursive: true })
            writeFileSync(profilePath(), JSON.stringify({ version: 1, owner: { name: 'Max Muster' }, entities: [] }))
            _resetOwnerProfileCacheForTest()
            expect(agentDesktopInputPauseReason()).toContain('Max hat den Desktop übernommen')
        } finally {
            release()
            writeFileSync(profilePath(), JSON.stringify({ version: 1, owner: { name: '' }, entities: [] }))
            _resetOwnerProfileCacheForTest()
        }
    })
})
