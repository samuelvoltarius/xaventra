import { describe, expect, it } from 'vitest'
import { authoritativeDiagnosticResponse, verifiedToolEvidenceResponse, incompleteToolResponse, screenshotFailureResponse, nodeScreenshotResponse, environmentOverviewResponse } from './tool-evidence-response.js'

describe('screenshot failure evidence', () => {
    it('retains per-node capture/delivery truth even when the overall tool reports a partial failure', () => {
        const text = nodeScreenshotResponse([{ toolName: 'mesh_screenshot', success: false, result: { captures: [
            { nodeId: 'spark', captured: true, delivered: true }, { nodeId: 'worker', captured: false, delivered: false, error: 'headless' },
        ] } }])
        expect(text).toContain('spark: Bild aufgenommen; Bildzustellung bestätigt')
        expect(text).toContain('worker: kein Bild aufgenommen; keine Bildzustellung bestätigt — keine Bildschirmaufnahme möglich')
        expect(text).not.toContain('In diesem Lauf wurde keine Bilddatei')
    })
    it('preserves the actual pre-execution policy denial', () => {
        const text = screenshotFailureResponse([{ toolName: 'desktop_screenshot', success: false,
            result: 'Error: Tool authorization rejected desktop_screenshot: Error: Desktop-Steuerung nur lokal' }])
        expect(text).toContain('Desktop-Steuerung nur lokal')
        expect(text).toContain('keine Bilddatei übertragen')
    })
    it('preserves locked-session evidence and redacts secrets', () => {
        const text = screenshotFailureResponse([{ toolName: 'desktop_screenshot', success: false,
            result: { error: 'Desktop session is locked; api_key=secret-value' } }])
        expect(text).toContain('Desktop session is locked')
        expect(text).not.toContain('secret-value')
    })
    it('does not invent a cause from another tool or successful capture', () => {
        const text = screenshotFailureResponse([
            { toolName: 'health_status', success: false, result: 'unrelated' },
            { toolName: 'desktop_screenshot', success: true, result: 'capture succeeded' },
        ])
        expect(text).not.toContain('unrelated')
        expect(text).not.toContain('capture succeeded')
        expect(text).toContain('keine Bilddatei übertragen')
    })
})

describe('grounded tool responses', () => {
    it('preserves formatted inventory when model synthesis times out', () => {
        const text = incompleteToolResponse([JSON.stringify({ formatted: '69 Adressen, 1248 Prüfungen; Teilsuche. api_key=secret-value' })])
        expect(text).toContain('69 Adressen, 1248 Prüfungen; Teilsuche')
        expect(text).not.toContain('secret-value')
        expect(text).not.toContain('keine verwertbaren')
    })
    it('delivers only verified inventory and mesh evidence without claiming general control', () => {
        const text = environmentOverviewResponse([
            { toolName: 'environment_inventory', success: true, result: '{"formatted":"Letzte Suche: Teilsuche; 69 Adressen"}' },
            { toolName: 'mesh_status', success: true, result: '5 Nodes online; api_key=secret-value' },
            { toolName: 'run_command', success: true, result: 'unrelated-secret' },
        ])
        expect(text).toContain('69 Adressen'); expect(text).toContain('5 Nodes online')
        expect(text).toContain('keine allgemeine Steuerfreigabe')
        expect(text).not.toContain('secret-value'); expect(text).not.toContain('unrelated-secret')
    })
    it('never fabricates successful inventory or recycles an earlier successful result after denial', () => {
        const text = environmentOverviewResponse([
            { toolName: 'environment_inventory', success: true, result: 'old findings' },
            { toolName: 'environment_inventory', success: false, result: 'permission denied' },
        ])
        expect(text).toContain('environment_inventory: in diesem Lauf nicht erfolgreich verifiziert')
        expect(text).toContain('mesh_status: in diesem Lauf nicht erfolgreich verifiziert')
        expect(text).not.toContain('old findings')
    })
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
