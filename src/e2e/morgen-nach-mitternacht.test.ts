/**
 * 2.89.4 Fix 4 over the real Telegram entry (createE2EHarness → message-pipeline
 * → set_reminder): „morgen“ after midnight is the day that is starting, and the
 * confirmation names weekday + date.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

describe('2.89.4 „morgen“ nach Mitternacht (realer Eingang)', () => {
    it('the confirmation names weekday and date, never a bare 09.10.', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Erinner mich morgen um 10 Uhr an die Besprechung', [
            { tool: 'set_reminder', args: { message: 'Besprechung', time: 'morgen um 10 Uhr' } },
            call => {
                const result = call.messages.filter(message => message.role === 'tool').at(-1)
                expect(result).toBeDefined()
                // Echo the real tool result instead of inventing a confirmation in the fake model.
                return { text: typeof result!.content === 'string' ? result!.content : JSON.stringify(result!.content) }
            },
        ])
        expect(result.error).toBeUndefined()
        const visible = [result.final, ...result.replies, ...result.buttons.map(b => b.text)].join('\n')
        expect(visible).toMatch(/Erinnerung gesetzt|Erinnerung/i)
        // weekday + date always; never only "10.10., 10:00"
        expect(result.executedTools).toContain('set_reminder')
        expect(visible).toMatch(/(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?[,]? \d{2}\.\d{2}\./)
        expect(visible).not.toMatch(/gesetzt für \*\*\d{2}\.\d{2}\.,/)
    }, T)

    it('the tool itself: at 01:12 „morgen gegen 10 Uhr“ is today 10:00, with a clarifying question', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const rt = await h!.module('tools/reminder-tool.js')
        // Fr 09.10.2026 01:12 Vienna = 2026-10-08T23:12Z
        const now = Date.parse('2026-10-08T23:12:00.000Z')
        expect(rt.morgenDayOffset(now)).toBe(0)
        const at = rt.parseTimeExpression('morgen gegen 10 Uhr', undefined, now)
        // the day that is starting (Fr 09.10.), not Saturday
        expect(new Date(at).toISOString()).toBe('2026-10-09T08:00:00.000Z')
        const choice = rt.describeMorgenChoice(at, 'morgen gegen 10 Uhr', now)
        expect(choice).toContain('heute,')
        expect(choice).toMatch(/Fr|Fr\./)
        expect(choice).toMatch(/oder meintest du/)
    }, T)
})
