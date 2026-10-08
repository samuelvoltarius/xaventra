import { describe, expect, it } from 'vitest'
import { wellFormed } from './well-formed-text.js'

describe('model requests carry no lone surrogates', () => {
    it('replaces a character cut in half and keeps whole emoji', () => {
        const cut = '🟢 grün'.slice(0, 1) + ' Rest'
        expect(() => encodeURIComponent(cut)).toThrow()
        expect(() => encodeURIComponent(wellFormed(cut))).not.toThrow()
        expect(wellFormed('🟢 grün')).toBe('🟢 grün')
        expect(wellFormed(42 as any)).toBe(42)
    })
})
