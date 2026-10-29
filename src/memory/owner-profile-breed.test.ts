import { describe, expect, it } from 'vitest'
import { contradictsProfile, normalizeOwnerProfile } from './owner-profile.js'

// 2.90.1 (owner-profile cleanup 29.10. 13:33): a learned "Luna ist ein Labrador" stood next to the profile's
// "Rasse: Collie" because the conflict check only fired on the word "Rasse". A breed in an is-a statement about
// the same animal contradicts the profile; a colour, a size or another dog mentioned in passing does not.
const profile = normalizeOwnerProfile({
    version: 1, owner: { name: 'Max Muster' },
    entities: [
        { name: 'Luna', kind: 'dog', aliases: [], facts: [{ attribute: 'Rasse', value: 'Collie' }] },
        { name: 'Max', kind: 'dog', aliases: [], facts: [{ attribute: 'Rasse', value: 'Labrador-Mischling' }] },
        { name: 'Mimi', kind: 'cat', aliases: [], facts: [{ attribute: 'Rasse', value: 'Maine Coon' }] },
    ], rules: [],
})!

describe('a breed contradicts the profile without the word "Rasse"', () => {
    it.each([
        'Luna ist ein Labrador.',
        'Luna ist ein junger Schäferhund mit Halsband.',
        'Max ist ein reinrassiger Beagle.',
        'Mimi ist eine Perserkatze.',
    ])('"%s" contradicts', text => {
        expect(contradictsProfile(profile, text)?.fact.attribute).toBe('Rasse')
    })

    it.each([
        'Luna ist ein grauer Hund.',
        'Max ist ein großer, grauer Hund.',
        'Luna ist ein Border Collie.',
        'Max ist ein Labrador.',
        'Luna spielt gern mit dem Labrador vom Nachbarn.',
        'Luna ist müde. Der Beagle von nebenan bellt.',
        'Mimi ist eine Maine-Coon-Katze.',
    ])('"%s" does not', text => {
        expect(contradictsProfile(profile, text)).toBeNull()
    })
})
