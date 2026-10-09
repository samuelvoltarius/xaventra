/**
 * 2.89.4 Fix 8 over the real entry (createDaemonMessageEntry → slash-commands
 * /layers, Telegram and Desktop input, scripted model):
 * `/layers` showed „L1 Unified Channels: ❌" although Telegram was running —
 * the line read the never-assigned `state.channelRouter`. L1 is the real
 * adapters in `state.channels` (the e2e harness wires the Telegram adapter).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness, type TurnResult } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

function visibleText(result: TurnResult): string {
    return [result.final, ...result.replies, ...result.buttons.map(button => button.text)].join('\n')
}

function expectL1Running(text: string): void {
    expect(text).toMatch(/L1 Unified Channels: ✅/)
    expect(text).not.toMatch(/L1 Unified Channels: ❌/)
    // The harness wires the real Telegram adapter into state.channels.
    expect(text).toMatch(/L1 Unified Channels: ✅ Telegram/)
}

describe('2.89.4 /layers L1 Unified Channels reflects state.channels (real entry)', () => {
    it('Telegram /layers: L1 is ✅ Telegram (buttons path)', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('/layers')
        expect(result.error).toBeUndefined()
        const text = visibleText(result)
        expect(text.length).toBeGreaterThan(0)
        expectL1Running(text)
    }, T)

    it('Desktop /layers: the same L1 line (text path)', async () => {
        h = await createE2EHarness()
        const result = await h.desktop('/layers')
        expect(result.error).toBeUndefined()
        const text = visibleText(result)
        expect(text.length).toBeGreaterThan(0)
        expectL1Running(text)
        expect(result.buttons).toHaveLength(0)
    }, T)
})
