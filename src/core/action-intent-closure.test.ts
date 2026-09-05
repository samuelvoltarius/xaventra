import { describe, expect, it } from 'vitest'
import { isConversationalClosure } from './action-intent.js'

describe('conversational closure', () => {
    it('closes prior tasks on praise', () => {
        expect(isConversationalClosure('super gut gemacht')).toBe(true)
        expect(isConversationalClosure('Danke! 😊')).toBe(true)
    })

    it('does not suppress a new action', () => {
        expect(isConversationalClosure('super, mach noch ein Bild')).toBe(false)
    })
})
