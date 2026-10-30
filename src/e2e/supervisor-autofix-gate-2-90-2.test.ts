/**
 * 2.92.0 (Regression zu 2.90.2, Codekarte D14-16): `/supervisor auto` schaltete LLM-Fixes ohne Bestätigung frei, an
 * PATCH_GATE vorbei. Der Supervisor mit seinem Auto-Tester ist entfernt: Es gibt keinen Auto-Fix-Pfad mehr, und der
 * Befehl verweist nur noch auf /doctor. Code ändert sich ausschließlich über PATCH_GATE.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('no automatic code fixes past PATCH_GATE', () => {
    it('"/supervisor auto" only points to /doctor over the real entry', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram('/supervisor auto', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/\/doctor/)
        expect(result.final).not.toMatch(/AUTO-FIX aktiviert|ohne Bestätigung/)
    }, 120_000)

    it('the auto-fix code is gone', () => {
        const root = process.env.NOVA_PROJECT_ROOT || process.cwd()
        for (const file of ['supervisor-manager.ts', 'auto-tester.ts', 'fix-generator.ts']) {
            expect(existsSync(join(root, 'src', 'supervisor', file)), file).toBe(false)
        }
    })
})
