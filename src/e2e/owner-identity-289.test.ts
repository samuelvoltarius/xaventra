/**
 * 2.89.8 (U6) One owner identity across the owner channels. A fact told on Telegram is
 * known on Desktop and vice versa; probe/REST principals stay separate; ambiguous config merges nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000
const systemOf = (call: { messages: Array<{ role: string; content: any }> }) =>
    call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')

describe('2.89.8 one owner identity', () => {
    it('a fact told on Telegram is recalled on Desktop, and one told on Desktop on Telegram', async () => {
        h = await createE2EHarness()
        const told = await h.telegram('Mein Hund Bello ist ein kleiner brauner Mischling und trägt ein graues Halsband.', [{ text: 'Notiert.' }])
        expect(told.error).toBeUndefined()
        const onDesktop = await h.desktop('Wie heißt mein Hund?', [call => {
            expect(systemOf(call)).toContain('Bello')
            return { text: 'Dein Hund heißt Bello.' }
        }])
        expect(onDesktop.error).toBeUndefined()
        expect(onDesktop.final).toContain('Bello')

        const back = await h.desktop('Meine Katze Mizzi ist eine weiße Perserkatze mit blauen Augen.', [{ text: 'Notiert.' }])
        expect(back.error).toBeUndefined()
        const onTelegram = await h.telegram('Wie heißt meine Katze?', [call => {
            expect(systemOf(call)).toContain('Mizzi')
            return { text: 'Deine Katze heißt Mizzi.' }
        }])
        expect(onTelegram.final).toContain('Mizzi')
        const governance = await h.module('memory/memory-governance.js')
        const store = governance.getMemoryGovernanceCoordinator()
        expect(store.list({ scope: `user:${OWNER_TELEGRAM_ID}` }).some((r: any) => /Mizzi/.test(r.content))).toBe(true)
        expect(store.list().some((r: any) => /desktop/i.test(r.scope))).toBe(false)
    }, T)

    it('a REST/probe principal does not see the owner memory', async () => {
        h = await createE2EHarness()
        await h.telegram('Mein Hund Bello ist ein kleiner brauner Mischling und trägt ein graues Halsband.', [{ text: 'Notiert.' }])
        const probe = await h.rest('Wie heißt mein Hund?', [call => {
            expect(systemOf(call)).not.toContain('Bello')
            return { text: 'Das weiß ich nicht.' }
        }], { probe: true })
        expect(probe.error).toBeUndefined()
    }, T)
})
