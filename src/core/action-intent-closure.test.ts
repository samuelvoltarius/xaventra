import { describe, expect, it } from 'vitest'
import { isConversationalClosure, isHistoryOnlyRequest } from './action-intent.js'

describe('conversational closure', () => {
    it('closes prior tasks on praise', () => {
        expect(isConversationalClosure('super gut gemacht')).toBe(true)
        expect(isConversationalClosure('Danke! 😊')).toBe(true)
    })

    it('does not suppress a new action', () => {
        expect(isConversationalClosure('super, mach noch ein Bild')).toBe(false)
    })

    it('narrows an explicitly history-only answer, not ordinary file requests', () => {
        expect(isHistoryOnlyRequest('Welchen Inhalt hatte die eben gelesene Datei? Antworte aus dem Verlauf, ohne sie erneut zu lesen.')).toBe(true)
        expect(isHistoryOnlyRequest('Antworte nur aus dem Gedächtnis.')).toBe(true)
        expect(isHistoryOnlyRequest('Answer only from conversation history.')).toBe(true)
        expect(isHistoryOnlyRequest('Lies die Datei erneut und vergleiche sie mit dem Verlauf.')).toBe(false)
        expect(isHistoryOnlyRequest('Was war vorher? Prüfe bitte den aktuellen Stand.')).toBe(false)
    })
})
