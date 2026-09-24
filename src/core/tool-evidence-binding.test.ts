import { describe, expect, it } from 'vitest'
import { inferRequiredToolTargets, matchedToolTargets } from './tool-evidence-binding.js'

describe('explicit GET query target binding', () => {
    it('uses a Markdown destination, not its display label or markup', () => {
        const targets = inferRequiredToolTargets("check --get '[https://search.example/search](https://search.example/search)' --data-urlencode 'q=Agent' --data-urlencode 'format=json'")
        expect(targets).toEqual(['https://search.example/search?q=agent&format=json'])
        expect(matchedToolTargets(targets, { url: 'https://search.example/search?q=Agent&format=json' })).toEqual(targets)
        expect(inferRequiredToolTargets('Prüfe [https://label.example](https://destination.example/page)')).toEqual(['https://destination.example/page'])
    })

    it('binds an explicit replay to the single GET example in a pasted transcript, not old backend metadata', () => {
        const text = `test es noch mal [24.09.2026 15:56] Person: Backend: searxng
URL: [https://search.example](https://search.example)
[24.09.2026 15:57] Assistant: Kein passendes Tool.
[24.09.2026 18:27] Person: check mal url
-sS --get '[https://search.example/search](https://search.example/search)'
--data-urlencode 'q=Agent' --data-urlencode 'format=json'
[24.09.2026 18:27] Assistant: Fehler.`
        expect(inferRequiredToolTargets(text)).toEqual(['https://search.example/search?q=agent&format=json'])
    })

    it('retains both destinations when two links are actually requested', () => {
        expect(inferRequiredToolTargets('Prüfe beide: [eins](https://one.example/a) und [zwei](https://two.example/b)'))
            .toEqual(['https://one.example/a', 'https://two.example/b'])
    })

    it('does not narrow a replay with multiple GET examples or an additional current target', () => {
        const history = `[24.09.2026 18:27] Person: --get 'https://one.example/search' --data-urlencode 'q=One'
[24.09.2026 18:28] Person: --get 'https://two.example/search' --data-urlencode 'q=Two'`
        expect(inferRequiredToolTargets(`test es noch mal ${history}`)).toEqual(['https://one.example/search', 'https://two.example/search'])
        expect(inferRequiredToolTargets(`test es noch mal und prüfe https://extra.example ${history}`)).toContain('https://extra.example')
    })

    it('deduplicates display-equivalent links but still requires every distinct target', () => {
        expect(inferRequiredToolTargets("--get '[Link](https://search.example/search)' https://search.example/search --data-urlencode 'q=Agent'"))
            .toEqual(['https://search.example/search?q=agent'])
        expect(matchedToolTargets(['https://one.example/a', 'https://two.example/b'], { url: 'https://one.example/a' }))
            .toEqual(['https://one.example/a'])
    })
    const goal = "check mal url -sS --get 'https://search.example/search' --data-urlencode 'q=Agent' --data-urlencode 'format=json'"
    it('binds the user-supplied query fields to the one explicit GET URL', () => {
        const targets = inferRequiredToolTargets(goal)
        expect(targets).toEqual(['https://search.example/search?q=agent&format=json'])
        expect(matchedToolTargets(targets, { url: 'https://search.example/search?q=Agent&format=json' })).toEqual(targets)
    })
    it('does not accept missing or changed query fields as the requested result', () => {
        const targets = inferRequiredToolTargets(goal)
        for (const url of ['https://search.example/search', 'https://search.example/search?q=Other&format=json', 'https://other.example/search?q=Agent&format=json']) {
            expect(matchedToolTargets(targets, { url })).toEqual([])
        }
    })
    it('does not interpret shell input or files as executable query values', () => {
        expect(inferRequiredToolTargets("check --get https://search.example/search --data-urlencode @secrets")).toContain('https://search.example/search')
        const ambiguous = inferRequiredToolTargets("check --get https://one.example/search https://two.example/search --data-urlencode 'q=Agent'")
        expect(ambiguous).toEqual(['https://one.example/search', 'https://two.example/search'])
    })
})
