/**
 * 2.89.4 Fix 6 over the real entry (createDaemonMessageEntry → slash-commands,
 * Telegram and Desktop input, scripted model):
 * `/ai` must never show the line „HANDLED“ — the internal COMMAND_HANDLED
 * marker is silent and is never a user-visible chat line.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness, type TurnResult } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

function expectNoHandled(result: TurnResult): void {
    expect(result.error).toBeUndefined()
    const visible = [result.final, ...result.replies, ...result.buttons.map(button => button.text)].join('\n')
    expect(visible).not.toMatch(/HANDLED/i)
    expect(visible).not.toContain('__HANDLED__')
    // The redirect help is the real answer of /ai.
    expect(visible.length).toBeGreaterThan(0)
}

describe('2.89.4 /ai never shows the line „HANDLED“ (real entry)', () => {
    it('Telegram /ai: redirect help only, no marker line', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('/ai')
        expectNoHandled(result)
        expect(result.final + result.replies.join('\n')).toContain('/mesh')
    }, T)

    it('Telegram /ai scan: mesh scan text only, no marker line', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('/ai scan')
        expectNoHandled(result)
    }, T)

    it('Desktop /ai: redirect help only, no marker line', async () => {
        h = await createE2EHarness()
        const result = await h.desktop('/ai')
        expectNoHandled(result)
        expect(result.final + result.replies.join('\n')).toContain('/mesh')
    }, T)

    it('Telegram /status answers via buttons — the marker stays out of every chat line', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('/status')
        expectNoHandled(result)
        // The status card itself is the answer (buttons path), not a „HANDLED“ line.
        expect(result.buttons.length).toBeGreaterThan(0)
    }, T)
})
