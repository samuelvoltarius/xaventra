import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BlueTeamService } from './blue-team.js'

describe('BlueTeamService', () => {
    it('creates a hash-chained incident timeline', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-blue-'))
        const service = new BlueTeamService(join(dir, 'incidents.json'))
        const incident = service.createIncident('Repeated login failures')
        service.addEvidence(incident.id, 'decision', 'test', 'First observation')
        service.addEvidence(incident.id, 'validation', 'test', 'Validated observation')
        expect(service.verifyEvidenceChain(incident.id)).toEqual({ valid: true, entries: 2 })
    })

    it('redacts secrets and finds defensive log signals', () => {
        const dir = mkdtempSync(join(process.cwd(), '.nova-data', 'blue-test-'))
        const file = join(dir, 'auth.log')
        writeFileSync(file, 'Failed password for root token=supersecretvalue123\nservice crash loop detected')
        const service = new BlueTeamService(join(dir, 'incidents.json'))
        const report = service.analyzeLog(file)
        expect(report.findings.length).toBeGreaterThanOrEqual(2)
        expect(report.findings[0].excerpt).not.toContain('supersecretvalue123')
        rmSync(dir, { recursive: true, force: true })
    })

    it('only proposes containment and requires approval', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-blue-'))
        const service = new BlueTeamService(join(dir, 'incidents.json'))
        const incident = service.createIncident('Test')
        const plan = service.containmentPlan(incident.id)
        expect(plan.mode).toBe('proposal-only')
        expect(plan.requiresApproval).toBe(true)
    })
})
