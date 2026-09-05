import { describe, expect, it } from 'vitest'
import { assessExecutionPreflight } from './execution-preflight.js'

describe('execution preflight', () => {
    it('allows read-only evidence collection', () => {
        const result = assessExecutionPreflight('Prüfe den Status', { requiresTool: true, kind: 'system-state' }, ['health_status'])
        expect(result.profile).toBe('observe')
        expect(result.riskScore).toBeLessThan(20)
    })

    it('requires approval for destructive mesh work', () => {
        const result = assessExecutionPreflight('Lösche den Dienst auf ns2', { requiresTool: true, kind: 'device-action' }, ['ssh_execute'])
        expect(result.profile).toBe('approval_required')
        expect(result.prerequisites).toContain('fresh main lease and fencing token')
        expect(result.requiredEvidence).toContain('operator approval')
    })

    it('keeps self modification behind sandbox and PATCH_GATE', () => {
        const result = assessExecutionPreflight('Ändere Novas Quellcode mit einem Patch', { requiresTool: true, kind: 'generic-action' }, ['self_evolve'])
        expect(result.profile).toBe('approval_required')
        expect(result.prerequisites.join(' ')).toContain('PATCH_GATE')
    })
})
