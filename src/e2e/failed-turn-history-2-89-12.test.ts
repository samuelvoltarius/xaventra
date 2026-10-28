/**
 * 2.89.12 (Telegram 28.10.2026, 2.89.11): 14:57 "Wie heißen meine Hunde?" ran into
 * "[Nova Agent] Error: Error: Timeout: model request exceeded deadline"; the user got
 * "Das hat zu lange gedauert … Versuch es bitte gleich noch einmal." and the session grew
 * from 20 to 22 entries. At 20:57 "test" was answered with the dog names (recall, kg_search):
 * the model read the failed exchange in the history as an open request to retry.
 * A failed turn is not part of the conversation the next turn is answered from.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness, type TurnResult } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

const T = 60_000

function prompt(result: TurnResult): string {
    const call = result.rounds[0]
    expect(call, 'the agent never called the model').toBeDefined()
    return call.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n---\n')
}

describe('2.89.12 failed turn is not answered later', () => {
    it('a timed-out question (live: the dog question) does not reach the prompt of the next message', async () => {
        h = await createE2EHarness()
        const owner = (text: string, script: any[]) => h!.send('Telegram', OWNER_TELEGRAM_ID, text, script, { messageContext: { chatId: OWNER_TELEGRAM_ID } })
        const failed = await owner('Nenne drei Flüsse in Peru', [() => { throw new Error('Timeout: model request exceeded deadline') }])
        expect(failed.final).toMatch(/zu lange gedauert/)
        const next = await owner('test', [{ text: 'Test angekommen.' }])
        expect(next.error).toBeUndefined()
        const seen = prompt(next)
        expect(seen).toContain('test')
        expect(seen).not.toContain('Nenne drei Flüsse in Peru')
        expect(seen).not.toMatch(/Versuch es bitte gleich noch einmal/)
    }, T)

    it('a successful turn stays in the history (control)', async () => {
        h = await createE2EHarness()
        const owner = (text: string, script: any[]) => h!.send('Telegram', OWNER_TELEGRAM_ID, text, script, { messageContext: { chatId: OWNER_TELEGRAM_ID } })
        await owner('Nenne drei Flüsse in Peru', [{ text: 'Amazonas, Ucayali, Marañón.' }])
        const next = await owner('test', [{ text: 'Test angekommen.' }])
        expect(prompt(next)).toContain('Nenne drei Flüsse in Peru')
    }, T)
})
