import { describe, expect, it } from 'vitest'
import { profileQuestionPart } from '../memory/owner-profile.js'
import { detectClockQuestion } from './clock-answer.js'
import { relayQuestionText } from './relay-text.js'

const NOTE = '(Antworte knapp auf Deutsch, ohne Markdown.)'

describe('relayQuestionText: the question without the relay style note', () => {
    it.each([
        [`wie spät ist es?\n${NOTE}`, 'wie spät ist es?'],
        [`wie spät ist es? ${NOTE}`, 'wie spät ist es?'],
        [`wie spät ist es?\n\n${NOTE}\n`, 'wie spät ist es?'],
        [`/freigabe hass_turn_on switch.k1 ${NOTE}`, '/freigabe hass_turn_on switch.k1'],
    ])('%j', (input, expected) => {
        expect(relayQuestionText(input)).toBe(expected)
    })
    it.each([
        'Wir fahren morgen (kurz vor Salzburg) los',
        'Was heißt das Zeichen (Antworte) auf dem Display?',
        'Erste Zeile\nZweite Zeile (mit Klammer)',
        'Sag mir den Preis (in Euro)',
    ])('leaves the words of the owner alone: %j', input => {
        expect(relayQuestionText(input)).toBe(input)
    })
})

describe('the note reaches none of the deterministic paths', () => {
    it('the clock answer still recognises the question', () => {
        expect(detectClockQuestion(`wie spät ist es?\n${NOTE}`)).toBe('zeit')
        expect(detectClockQuestion(`wie spät ist es? ${NOTE}`)).toBe('zeit')
    })
    it('the profile question part stays the question', () => {
        expect(profileQuestionPart(`Wie heißen meine Hunde?\n${NOTE}`)).toBe('Wie heißen meine Hunde?')
        expect(profileQuestionPart(`Wie heißen meine Hunde? ${NOTE}`)).toBe('Wie heißen meine Hunde?')
    })
})
