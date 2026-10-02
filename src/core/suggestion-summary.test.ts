import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordThoughtAnswer, suggestionSummaryLines } from './decisions.js'

// Integration 2.83.0: package C counts Ja/Nein per suggestion kind, package D
// shows the learning curve. The evening report gets one line about accepted
// and declined suggestions and names the kinds that are now suppressed.
describe('Abendbericht: Vorschläge angenommen/abgelehnt', () => {
    it('zählt Ja/Nein im Fenster und nennt unterdrückte Arten', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'sugg-'))
        const opts = { dataDir, isMain: () => true, now: () => Date.parse('2026-10-02T10:00:00Z') }
        for (let i = 0; i < 3; i++) recordThoughtAnswer('idee:werkzeug-cache', 'nein', opts)
        recordThoughtAnswer('idee:schneller-start', 'ja', opts)
        const lines = suggestionSummaryLines(Date.parse('2026-10-01T00:00:00Z'), opts)
        expect(lines.join('\n')).toContain('1 angenommen, 3 abgelehnt')
        expect(lines.join('\n')).toContain('idee:werkzeug-cache')
    })

    it('ohne Antworten: keine Zeile', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'sugg-'))
        expect(suggestionSummaryLines(0, { dataDir, isMain: () => true })).toEqual([])
    })
})
