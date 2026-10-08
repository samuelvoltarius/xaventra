/**
 * 2.89.3 (live 08.10.2026 19:08): "Send mir eine screen Shot von alleine nodes wo es geht und wenn du schon
 * dabei bist Google nach mir" - only the screenshot half was offered and answered, the Google half vanished.
 * Over the real Telegram entry; only the model is scripted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness, type HarnessOptions } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
async function harness(options: HarnessOptions = {}): Promise<E2EHarness> { h = await createE2EHarness(options); return h }
const T = 60_000
const REQUEST = 'Send mir eine screen Shot von alleine nodes wo es geht und wenn du schon dabei bist Google nach mir'

describe('2.89.3 two tasks in one request', () => {
    it('screenshot + Google: both tool sets offered, both halves answered', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram(REQUEST, [
            { tool: 'mesh_screenshot', args: {} },
            { tool: 'searxng_search', args: { query: 'Alfred Aigner' } },
            { text: 'Zu dir finde ich: Alfred Aigner, Fotograf und Videograf in Salzburg.' },
        ])
        expect(result.offeredTools).toEqual(expect.arrayContaining(['mesh_screenshot', 'searxng_search']))
        expect(result.executedTools).toContain('searxng_search')
        expect(result.final).toContain('Fotograf und Videograf in Salzburg')
        expect(result.final).not.toContain('Bildzustellung')
        expect(result.final).not.toMatch(/nicht geschafft/)
    }, T)

    it('screenshot + Google where the second half is not done: the answer says so', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram(REQUEST, [
            { tool: 'mesh_screenshot', args: {} },
            { text: 'Screenshots sind raus.' },
        ])
        expect(result.final).toMatch(/Den zweiten Teil \(„Google nach mir“\) habe ich nicht geschafft/)
        expect(result.final).toMatch(/Soll ich es noch einmal versuchen\?/)
    }, T)

    it('doppelauftrag: time and weather in one request - both answered', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram('Wie spät ist es und wie ist das Wetter in Wien?', [
            { tool: 'searxng_search', args: { query: 'Wetter Wien' } },
            { text: 'Es ist gerade 19:08 Uhr. In Wien sind es 14 Grad und bewölkt.' },
        ])
        expect(result.offeredTools.some((name: string) => /search|weather|wetter|time|zeit|datetime/i.test(name)), result.offeredTools.join(',')).toBe(true)
        expect(result.final).toMatch(/19:08/)
        expect(result.final).toMatch(/Wien/)
    }, T)
})
