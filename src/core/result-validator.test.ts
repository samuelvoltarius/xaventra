import { describe, expect, it } from 'vitest'
import { validateToolOutcome } from './result-validator.js'

describe('result validator', () => {
    it('rejects image announcements without an artifact', () => {
        expect(validateToolOutcome('generate_image', { success: true, message: 'started' }).success).toBe(false)
    })

    it('accepts a generated image path', () => {
        expect(validateToolOutcome('generate_image', { success: true, path: 'C:\\tmp\\salzburg.png' }).success).toBe(true)
    })

    it('rejects screenshot success without a file', () => {
        expect(validateToolOutcome('desktop_screenshot', true, { requiresTool: true, kind: 'screenshot' }).success).toBe(false)
    })
})
