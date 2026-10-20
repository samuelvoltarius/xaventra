/**
 * 2.89.8 (U1, U2): causes of live Telegram failures, over the real Telegram entry (only the model is scripted).
 *  U1 everyday questions reach the model - no word-list question from the clarification gate
 *  U2 research (search / browser / fetch_url) is not a makeshift: no "no matching tool" stop after 3 calls
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 120_000
const GATE_QUESTION = /Worauf genau bezieht sich das|Auf welchem Node, Dienst oder Ziel/

describe('2.89.8 U1: no gate question before the model', () => {
    it.each([
        ['Was ist das?', 'Das ist ein Beispiel.'],
        ['wo läufst du?', 'Ich laufe auf dem Main.'],
        ['schick mir das', 'Gern, was genau soll ich schicken?'],
        ['google nach Wanderwegen bei Salzburg', 'Ich suche danach.'],
    ])('"%s" goes to the model', async (text, answer) => {
        h = await createE2EHarness()
        const result = await h.telegram(text, [{ text: answer }, { text: answer }], { fallback: answer })
        expect(result.error).toBeUndefined()
        expect(result.replies.join('\n')).not.toMatch(GATE_QUESTION)
        // "wo läufst du?" has its own deterministic probe answer; all others reach the model.
        expect(result.replies.length).toBeGreaterThan(0)
        if (!/läufst/.test(text)) expect(result.calls.length).toBeGreaterThan(0)
    }, T)
})

describe('2.89.8 U2: research is no makeshift', () => {
    it('5 searches and 3 fetch_url calls end with an answer and sources, not with "no matching tool"', async () => {
        h = await createE2EHarness({
            searxng: true,
            routes: [{ match: /^https:\/\/example\.com\//, respond: () => ({ text: '<html><body><h1>Wanderweg</h1><p>Rundweg 12 km.</p></body></html>' }) }],
        })
        const searches = Array.from({ length: 5 }, (_, i) => ({ tool: 'searxng_search', args: { query: `Wanderweg Wien ${i}` } }))
        const fetches = ['a', 'b', 'c'].map(x => ({ tool: 'fetch_url', args: { url: `https://example.com/${x}` } }))
        const result = await h.telegram('Recherchiere Wanderwege bei Wien und nenne mir Quellen.', [
            ...searches, ...fetches, { text: 'Wanderweg A (https://example.com/a): 12 km. Quelle: example.com' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.executedTools.filter((n: string) => n === 'searxng_search').length).toBe(5)
        expect(result.executedTools.filter((n: string) => n === 'fetch_url').length).toBe(3)
        expect(result.trace).not.toContain('capability:limit-gap')
        expect(result.final).not.toMatch(/kein passendes Werkzeug/)
        expect(result.final).toMatch(/example\.com/)
    }, T)

    it('a shell loop still hits the makeshift limit', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Wie ist die Luftqualität in Wien gerade?', [
            { tool: 'run_command', args: { command: 'echo 1' } },
            { tool: 'run_command', args: { command: 'echo 2' } },
            { tool: 'run_command', args: { command: 'echo 3' } },
            { tool: 'run_command', args: { command: 'echo 4' } },
            { text: 'Kein Messwert gefunden.' },
        ])
        expect(result.executedTools.filter((n: string) => n === 'run_command').length).toBeLessThanOrEqual(3)
    }, T)
})
