import { describe, expect, it } from 'vitest'
import { isSuccessfulToolResult } from './tool-result-quality.js'

describe('tool result quality', () => {
    it('rejects string-encoded failures', () => {
        expect(isSuccessfulToolResult('❌ Bildgenerierung fehlgeschlagen: Scope fehlt')).toBe(false)
        expect(isSuccessfulToolResult('Image API Fehler (401): unauthorized')).toBe(false)
    })
    it('accepts verified output', () => {
        expect(isSuccessfulToolResult('✅ Bild generiert: C:/tmp/a.png')).toBe(true)
        expect(isSuccessfulToolResult({ success: true, path: 'a.png' })).toBe(true)
    })
})
