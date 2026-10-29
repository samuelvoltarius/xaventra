/**
 * 2.89.13 (Abnahme 2.89.12 über den Quiet-Hub, 29.10.2026 01:26): the relay appends
 * "(Antworte knapp auf Deutsch, ohne Markdown.)" to every message. `/freigabe hass_turn_on
 * switch.k1_max_steckdose` then issued the code for `…switch.k1_max_steckdose (Antworte knapp …)`,
 * which never matches the real tool call. The approval detail is the first line only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('2.89.13 /freigabe binds the first line only', () => {
    it('an appended style line does not become part of the approval target', async () => {
        h = await createE2EHarness()
        const result = await h.desktop('/freigabe hass_turn_on switch.k1_max_steckdose\n(Antworte knapp auf Deutsch, ohne Markdown.)', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('tool:hass_turn_on:switch.k1_max_steckdose (5 min')
        expect(result.final).not.toMatch(/Antworte knapp/)
    }, 60_000)
})
