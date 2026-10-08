import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPAIR_SANDBOX_LIMITS, repairSandboxCommandTimeout } from './patch-sandbox.js'

// 2.83.0 Punkt 11: die gewachsene Suite braucht im Rollback-Lauf mehr als
// 3 Minuten je Befehl und mehr als 15 Minuten insgesamt (Main-CI repair-sandbox
// „Sandbox command deadline exceeded“). Die Grenzen bleiben fest im Code.
describe('Reparatur-Sandbox: Zeitlimits (Punkt 11)', () => {
    it('Standard und harte Obergrenze je Befehl 480 s, Gesamtbudget 2100 s', () => {
        expect(REPAIR_SANDBOX_LIMITS).toEqual({ commandDefaultMs: 480_000, commandMaxMs: 480_000, commandMinMs: 1000, totalBudgetMs: 2_100_000 })
        expect(repairSandboxCommandTimeout(undefined)).toBe(480_000)
        expect(repairSandboxCommandTimeout('')).toBe(480_000)
    })

    it('Operator darf verkürzen, aber nie über die Obergrenze oder unter 1 s', () => {
        expect(repairSandboxCommandTimeout('10000')).toBe(10_000)
        expect(repairSandboxCommandTimeout('480000')).toBe(480_000)
        expect(() => repairSandboxCommandTimeout('480001')).toThrow(/Invalid sandbox command timeout/)
        expect(() => repairSandboxCommandTimeout('999')).toThrow(/Invalid sandbox command timeout/)
        expect(() => repairSandboxCommandTimeout('12.5')).toThrow(/Invalid sandbox command timeout/)
        expect(() => repairSandboxCommandTimeout('abc')).toThrow(/Invalid sandbox command timeout/)
    })

    it('CI-Schritt und Job lassen dem vollen Budget plus letztem Befehl Luft', () => {
        const workflow = readFileSync(join(process.env.NOVA_PROJECT_ROOT || process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')
        const job = workflow.slice(workflow.indexOf('  repair-sandbox:'))
        const jobMinutes = Number(job.match(/^    timeout-minutes: (\d+)/m)?.[1])
        const stepMinutes = Number(job.match(/check-repair-sandbox\.mjs\s+timeout-minutes: (\d+)/)?.[1])
        // Worst case: budget nearly used, then one more command plus container slack.
        const worstCaseMinutes = (REPAIR_SANDBOX_LIMITS.totalBudgetMs + REPAIR_SANDBOX_LIMITS.commandMaxMs + 20_000) / 60_000
        expect(stepMinutes).toBeGreaterThan(worstCaseMinutes)
        expect(jobMinutes).toBeGreaterThan(stepMinutes)
    })
})
