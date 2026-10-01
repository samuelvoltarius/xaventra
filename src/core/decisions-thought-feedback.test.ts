import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    migrateThoughtFeedback, recordThoughtAnswer, thoughtImportanceFactor, type DecisionOptions,
} from './decisions.js'

// Ein Regelsystem: die Rückmeldungen auf Gedanken (früher
// thinking/decision-learning.ts, eigene Datei thinking/decisions.json)
// gehören jetzt zu decisions.ts. „Immer erlauben?“ schlägt dieses Modul nicht
// mehr vor — Erlaubnisse gehören allein den Knopf-Karten/der Vertrauensleiter.
let dir: string
let opts: DecisionOptions & { ledger?: { recordApproval(runId: string, approval: Record<string, unknown>): void } }
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decisions-feedback-'))
    opts = { dataDir: dir, isMain: () => true, ledger: { recordApproval: () => {} } }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Rückmeldungen auf Gedanken in decisions.ts', () => {
    it('„Nein“ senkt die Wichtigkeit der Art (nie unter 0,2), „Ja“ hebt sie langsam wieder', () => {
        expect(thoughtImportanceFactor('neustart-vorschlag', opts)).toBe(1)
        recordThoughtAnswer('neustart-vorschlag', 'nein', opts)
        const once = thoughtImportanceFactor('neustart-vorschlag', opts)
        expect(once).toBeLessThan(1)
        for (let i = 0; i < 30; i++) recordThoughtAnswer('neustart-vorschlag', 'nein', opts)
        expect(thoughtImportanceFactor('neustart-vorschlag', opts)).toBeGreaterThanOrEqual(0.2)
        for (let i = 0; i < 3; i++) recordThoughtAnswer('idee:cache', 'nein', opts)
        const low = thoughtImportanceFactor('idee:cache', opts)
        for (let i = 0; i < 4; i++) recordThoughtAnswer('idee:cache', 'ja', opts)
        expect(thoughtImportanceFactor('idee:cache', opts)).toBeGreaterThan(low)
        expect(thoughtImportanceFactor('anderes', opts)).toBe(1)
    })

    it('fünfmal „Ja“ erzeugt keinen „Immer erlauben?“-Vorschlag und keine Erlaubnis', () => {
        for (let i = 0; i < 8; i++) expect(recordThoughtAnswer('installieren:ffmpeg', 'ja', opts)).toBe(true)
        const file = JSON.parse(readFileSync(join(dir, 'decisions', 'gedanken-rueckmeldungen.json'), 'utf8'))
        expect(file.kinds['installieren:ffmpeg']).toMatchObject({ yes: 8, no: 0 })
        expect(JSON.stringify(file)).not.toMatch(/immer-erlauben|proposed/i)
        expect(existsSync(join(dir, 'decisions', 'decisions.json'))).toBe(false)
    })

    it('jede Antwort landet im Outcome-Ledger (bereinigte Lauf-ID)', () => {
        const recordApproval = vi.fn()
        recordThoughtAnswer('Installieren: ffmpeg/../x', 'spaeter', { ...opts, ledger: { recordApproval } })
        const [runId, payload] = recordApproval.mock.calls[0]
        expect(runId).toMatch(/^decision-[A-Za-z0-9_.@-]+$/)
        expect(runId).not.toContain('..')
        expect(payload).toMatchObject({ answer: 'spaeter', source: 'knopf' })
    })

    it('Gegenprobe: ein Worker schreibt nichts', () => {
        expect(recordThoughtAnswer('x', 'nein', { ...opts, isMain: () => false })).toBe(false)
        expect(existsSync(join(dir, 'decisions', 'gedanken-rueckmeldungen.json'))).toBe(false)
    })

    it('Migration: thinking/decisions.json wird übernommen und als .migriert umbenannt', () => {
        mkdirSync(join(dir, 'thinking'), { recursive: true })
        const old = join(dir, 'thinking', 'decisions.json')
        writeFileSync(old, JSON.stringify({ version: 1, kinds: {
            'neustart-vorschlag': { yesStreak: 0, yes: 2, no: 3, later: 1, penalty: 3, proposedForStreak: false, lastAt: '2026-09-30T10:00:00.000Z' },
        } }))
        expect(migrateThoughtFeedback(opts)).toEqual({ migrated: 1 })
        expect(existsSync(old)).toBe(false)
        expect(existsSync(`${old}.migriert`)).toBe(true)
        expect(thoughtImportanceFactor('neustart-vorschlag', opts)).toBeCloseTo(0.75 ** 3)
        // idempotent: a second start finds nothing to migrate
        expect(migrateThoughtFeedback(opts)).toEqual({ migrated: 0 })
    })
})
