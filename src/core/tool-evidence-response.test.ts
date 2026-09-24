import { describe, expect, it } from 'vitest'
import { authoritativeDiagnosticResponse, verifiedToolEvidenceResponse, incompleteToolResponse } from './tool-evidence-response.js'

describe('grounded tool responses', () => {
    it('does not present acknowledgements and empty search as completed research', () => {
        const text = incompleteToolResponse(['✅ Erfolgreich!', '{"success":true,"results":[]}'])
        expect(text).toContain('nicht abgeschlossen')
        expect(text).not.toContain('✅')
    })
    it('preserves long findings and source URLs as incomplete observations', () => {
        const text = incompleteToolResponse([JSON.stringify({success:true,results:[{title:'Finding',url:'https://example.org/source',content:'A'.repeat(500)}]})])
        expect(text).toContain('https://example.org/source')
        expect(text).toContain('A'.repeat(500))
        expect(text).toContain('keine abschließende Antwort')
    })
    it('uses the exact self-setup result instead of invented missing capabilities', () => {
        const result = authoritativeDiagnosticResponse([{
            toolName: 'self_setup_plan', success: true,
            result: 'Actions: 1\n- local:gpu-binding-vulkan',
        }])
        expect(result).toBe('Actions: 1\n- local:gpu-binding-vulkan')
        expect(result).not.toContain('STT')
        expect(result).not.toContain('Embedding')
    })

    it('falls back to redacted verified tool evidence after a contradiction', () => {
        const result = verifiedToolEvidenceResponse([{
            toolName: 'self_setup_plan', success: true,
            result: 'api_key=secret-value; actual=GPU binding only',
        }])
        expect(result).toContain('actual=GPU binding only')
        expect(result).not.toContain('secret-value')
    })
})
