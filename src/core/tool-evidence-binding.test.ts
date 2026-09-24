import { describe, expect, it } from 'vitest'
import { inferRequiredToolTargets, matchedToolTargets } from './tool-evidence-binding.js'

describe('explicit GET query target binding', () => {
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
