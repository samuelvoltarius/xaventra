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

    it('does not reinterpret failure words inside a successful multi-line report', () => {
        const inventory = [
            '# Xaventra Self-Introspection — tools',
            '',
            '- health_status: prüft den Zustand; meldet "nicht gefunden" bei fehlender Ressource',
            '- nova_capabilities: listet verfügbare Tools',
        ].join('\n')

        expect(isSuccessfulToolResult(inventory)).toBe(true)
    })
})
