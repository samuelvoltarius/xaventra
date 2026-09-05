import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyApprovedDoctorProposal, applySafeFixes, type DoctorConfigProposal } from './safe-fixes.js'
import type { DoctorReport } from './types.js'

function report(): DoctorReport {
    return {
        timestamp: new Date().toISOString(), version: 'test', platform: process.platform,
        nodeVersion: process.version, cwd: process.cwd(),
        checks: {} as DoctorReport['checks'],
        issues: [{
            code: 'PORT_REST_OCCUPIED', severity: 'warning', message: 'Test port is occupied',
            fix: { type: 'config_patch', configPath: 'server.port', configValue: 18790, hint: 'Use test port', safe: true },
        }],
        summary: { errors: 0, warnings: 1, infos: 0, ok: 0, healthy: false },
    }
}

describe('Doctor PATCH_GATE boundary', () => {
    it('queues a sandbox-validated proposal without mutating live config', async () => {
        const configPath = join(process.cwd(), 'xaventra.config.json')
        const before = readFileSync(configPath, 'utf-8')
        const result = await applySafeFixes(report())
        const after = readFileSync(configPath, 'utf-8')
        const proposals = JSON.parse(
            readFileSync(join(process.cwd(), '.nova-data', 'patch-proposals.json'), 'utf-8'),
        ) as DoctorConfigProposal[]

        expect(after).toBe(before)
        expect(result.applied).toEqual([])
        expect(proposals.some(item => item.kind === 'doctor-config' && item.status === 'queued' && item.sandbox.verified)).toBe(true)
    })

    it('refuses application without the PATCH_GATE token', async () => {
        await applySafeFixes(report())
        const proposal = (JSON.parse(
            readFileSync(join(process.cwd(), '.nova-data', 'patch-proposals.json'), 'utf-8'),
        ) as DoctorConfigProposal[]).find(item => item.kind === 'doctor-config')!
        const result = await applyApprovedDoctorProposal(proposal, '__definitely_invalid__')
        expect(result.applied).toBe(false)
        expect(result.message).toContain('PATCH_GATE')
    })
})
