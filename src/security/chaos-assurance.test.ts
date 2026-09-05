import { describe, expect, it } from 'vitest'
import { runChaosAssurance } from './chaos-assurance.js'

describe('chaos assurance', () => {
    it('keeps policy, workspace, plugins and evidence fail closed', async () => {
        const report = await runChaosAssurance()
        expect(report.passed).toBe(true)
        expect(report.checks.every(check => check.passed)).toBe(true)
    })
})
