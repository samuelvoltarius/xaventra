import { describe, expect, it } from 'vitest'
import { resolveEntityBatch, resolveEntityTurn } from './entity-extractor.js'

describe('general entity reference resolution', () => {
    it('leaves action requests and answer feedback to their existing handlers', () => {
        for (const text of ['Sie hat Computer-Use … dann mach es auf und versuch es nochmal', 'Das ist falsch.']) {
            const result = resolveEntityTurn('not-an-entity', text)
            expect(result.question).toBeUndefined()
            expect(result.facts).toEqual([])
        }
    })
    it('never promotes speculation or a question to an entity fact', () => {
        expect(resolveEntityTurn('guess', 'Alpha ist vielleicht blau.').facts).toEqual([])
        expect(resolveEntityTurn('guess', 'Alpha ist blau?').facts).toEqual([])
        resolveEntityTurn('pending-guess', 'Er ist blau.', true)
        expect(resolveEntityTurn('pending-guess', 'Das ist Alpha, vielleicht.').facts).toEqual([])
        expect(resolveEntityTurn('pending-guess', 'Das ist Beta.').facts).toEqual([{ name: 'Beta', predicate: 'beschreibung', value: 'blau' }])
    })
    it('asks when a pronoun can refer to two explicitly mentioned entities', () => {
        resolveEntityTurn('ambiguous', 'Das ist Alpha.')
        resolveEntityTurn('ambiguous', 'Das ist Beta.')
        expect(resolveEntityTurn('ambiguous', 'Alpha und Beta sind hier. Er ist blau.')).toMatchObject({ facts: [], question: expect.any(String) })
    })
    it('keeps image boundaries when several images arrive in the same burst', () => {
        const result = resolveEntityBatch('images-batch', [
            { content: 'Das ist Alpha. Er ist braun.', image: {} },
            { content: 'Das ist Alpha.', image: {} },
            { content: 'Ein neues Bild.', image: {} },
            { content: 'Nicht ganz, er ist grau.' },
            { content: 'Und das ist nicht Alpha.' },
        ])
        expect(result.question).toBeTruthy()
        expect(result.facts).toEqual([])
        expect(resolveEntityTurn('images-batch', 'Das ist Beta.').facts).toEqual([{ name: 'Beta', predicate: 'beschreibung', value: 'grau' }])
    })
    it.each(['Hund', 'Person', 'Drucker', 'Ort', 'Projekt', 'Dokument', 'Termin', 'Fahrzeug'])('keeps a new image separate from a named %s', kind => {
        const scope = `image:${kind}`
        resolveEntityTurn(scope, 'Das ist Alpha. Er ist braun.', true)
        const newImage = resolveEntityTurn(scope, 'Nicht ganz, er ist grau. Und das ist nicht Alpha.', true)
        expect(newImage.question).toBeTruthy()
        expect(newImage.facts).toEqual([])
        const identified = resolveEntityTurn(scope, 'Das ist Beta.')
        expect(identified.facts).toEqual([{ name: 'Beta', predicate: 'beschreibung', value: 'grau' }])
        expect(identified.prompt).toContain('Alpha, Beta')
    })
    it('asks when no entity is identified and scopes conversation context', () => {
        expect(resolveEntityTurn('unknown', 'Er ist blau.').question).toBeTruthy()
        resolveEntityTurn('owner-a', 'Das ist Alpha.')
        expect(resolveEntityTurn('owner-b', 'Er ist blau.').question).toBeTruthy()
    })
    it('uses explicit names and ordinals rather than silently replacing another entity', () => {
        resolveEntityTurn('ordinal', 'Das ist Alpha.')
        resolveEntityTurn('ordinal', 'Das ist Beta.')
        expect(resolveEntityTurn('ordinal', 'Der erste, er ist rot.').facts[0]).toMatchObject({ name: 'Alpha', value: 'rot' })
        expect(resolveEntityTurn('ordinal', 'Beta ist blau.').facts[0]).toMatchObject({ name: 'Beta', value: 'blau' })
        expect(resolveEntityTurn('ordinal', 'Der zweite ist grün.').facts[0]).toMatchObject({ name: 'Beta', value: 'grün' })
    })
    it('does not rebind an explicitly rejected identity at the beginning of a sentence', () => {
        resolveEntityTurn('denied-case', 'Das ist Alpha.')
        expect(resolveEntityTurn('denied-case', 'Das ist nicht Alpha.').question).toBeTruthy()
        expect(resolveEntityTurn('denied-case', 'Das ist Alpha.').question).toBeTruthy()
    })
})
