/**
 * 2.90.2 (Codekarte D14-16, coordinator review): `/supervisor auto` set `(supervisor as any).config.autoFix = true`;
 * supervisor-manager/auto-tester would then apply LLM fixes without confirmation, including git checkout/commit -
 * past PATCH_GATE. Automatic code fixes run only through PATCH_GATE; the supervisor's autoFix stays false.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('/supervisor auto never switches on automatic code fixes', () => {
    it('is refused over the real entry and autoFix stays false', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram('/supervisor auto', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/PATCH_GATE/)
        expect(result.final).not.toMatch(/AUTO-FIX aktiviert/)
        const { getSupervisor } = await h.module('supervisor/supervisor-manager.js')
        expect((getSupervisor() as any).config.autoFix).toBe(false)
    }, 120_000)

    it('no path can set it: constructor option and a direct write stay without effect', async () => {
        const { SupervisorManager } = await import('../supervisor/supervisor-manager.js')
        const supervisor = new SupervisorManager({ autoFix: true, enabled: false }) as any
        expect(supervisor.config.autoFix).toBe(false)
        expect(() => { supervisor.config.autoFix = true }).toThrow()
        expect(supervisor.config.autoFix).toBe(false)
        expect(supervisor.tester.config.autoCommit).toBe(false)
    })
})
