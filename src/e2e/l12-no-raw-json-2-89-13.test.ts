/**
 * 2.89.13 (Telegram-Abnahme 2.89.12, 29.10.2026): with a background model the L12 second opinion ran for the
 * first time and replaced flagged answers with the raw tool result — 00:54:20 "test" → get_current_time JSON,
 * 01:04:48 heise → fetch_url JSON, 01:13:59 "wieder aus" → hass_get JSON. A flagged answer is marked as
 * not fully verified; raw tool output never becomes the reply. Over the real Telegram entry; the model and
 * the L12 verdict are scripted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const verdict = vi.hoisted(() => ({ honest: false, issues: ['Die Befunde zu xaventra-lab stehen nicht in den Tool-Ausgaben.'] }))
vi.mock('../layers/L12-anti-hallucination.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    validateWithLLM: async () => verdict,
}))

import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 60_000

describe('2.89.13 L12 never answers with raw tool output', () => {
    it('a flagged answer is marked, not replaced by get_current_time JSON', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('test', [{ tool: 'get_current_time', args: {} }, { text: 'Test angekommen, alles läuft.' }])
        expect(result.error).toBeUndefined()
        expect(result.final).not.toMatch(/get_current_time|"uhrzeit"|unix_timestamp/)
        expect(result.final).toContain('Test angekommen, alles läuft.')
        expect(result.final).toMatch(/nicht (?:vollständig|alles) (?:belegt|bestätigt)/i)
    }, T)
})
