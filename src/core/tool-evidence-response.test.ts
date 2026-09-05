import { describe, expect, it } from 'vitest'
import { authoritativeDiagnosticResponse, verifiedToolEvidenceResponse } from './tool-evidence-response.js'

describe('grounded tool responses', () => {
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
