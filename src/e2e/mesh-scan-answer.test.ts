/**
 * 2.89.4 Fix 7 over the real entry (createDaemonMessageEntry → slash-commands
 * /mesh scan, Telegram and Desktop input, scripted model):
 * `/mesh scan` used to end as "❌ Abgebrochen · N s" with no reason — the scan
 * report starts with 🔍 and was swallowed as a progress line. The report is the
 * answer and is delivered; an abort always carries one honest sentence.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

function expectScanAnswer(text: string): void {
    expect(text).toMatch(/Mesh AI Scan|AI Services/i)
    expect(text).not.toMatch(/Abgebrochen/)
    expect(text).not.toMatch(/^❌ Abgebrochen · \d+ s$/m)
}

describe('2.89.4 /mesh scan answers instead of aborting (real entry)', () => {
    it('Telegram /mesh scan: the scan report is the reply', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('/mesh scan')
        expect(result.error).toBeUndefined()
        const visible = [result.final, ...result.replies].join('\n')
        expect(visible.length).toBeGreaterThan(0)
        expectScanAnswer(visible)
    }, T)

    it('Desktop /mesh scan: the same report, no abort line', async () => {
        h = await createE2EHarness()
        const result = await h.desktop('/mesh scan')
        expect(result.error).toBeUndefined()
        const visible = [result.final, ...result.replies].join('\n')
        expect(visible.length).toBeGreaterThan(0)
        expectScanAnswer(visible)
    }, T)
})
