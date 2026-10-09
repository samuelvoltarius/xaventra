import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'
let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
// A public one-pixel fixture, never an owner's actual photograph.
const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }

describe('entity correction across the real daemon entry', () => {
    it('keeps three images/two identities separate, settles a correction burst, then recalls each after restart', async () => {
        h = await createE2EHarness({ keepRoot: true })
        const root = h.root
        const mu = await h.module('users/multi-user-middleware.js')
        // Shorter test-only clock; the separate fake-clock test covers 20 seconds.
        mu.setEntityWindowForTests(50)
        const first = await h.send('Telegram', OWNER_TELEGRAM_ID, 'Das ist Alpha. Er ist braun und trägt ein graues Halsband.', [
            call => {
                expect(call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')).toContain('Alpha ist braun')
                return { text: 'Jetzt gespeichert: Alpha ist braun und trägt ein graues Halsband.' }
            },
        ], { image, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        expect(first.error).toBeUndefined()
        await h.send('Telegram', OWNER_TELEGRAM_ID, 'Das ist Alpha.', [{ text: 'Alpha ist durch deine Benennung zugeordnet.' }], { image, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        await h.send('Telegram', OWNER_TELEGRAM_ID, 'Ein weiteres Bild.', [{ text: 'Das ist ein neues Bild; die Identität ist noch nicht bestätigt.' }], { image, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        const correction = await h.burst([
            { channel: 'Telegram', from: OWNER_TELEGRAM_ID, text: 'Nicht ganz, er ist ein grauer Schopfhund.', messageContext: { chatId: OWNER_TELEGRAM_ID } },
            { channel: 'Telegram', from: OWNER_TELEGRAM_ID, text: 'Und das ist nicht Alpha.', delayMs: 10, messageContext: { chatId: OWNER_TELEGRAM_ID } },
        ])
        expect(correction.error).toBeUndefined()
        expect(correction.final).toMatch(/Wie heißt|Welches Wesen/)
        const identified = await h.telegram('Das ist Beta.', [call => {
            const system = call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
            expect(system).toContain('Beta ist ein grauer Schopfhund')
            return { text: 'Jetzt gespeichert: Beta ist ein grauer Schopfhund.' }
        }])
        expect(identified.error).toBeUndefined()
        const governance = await h.module('memory/memory-governance.js')
        const records = governance.getMemoryGovernanceCoordinator().list()
        const active = records.filter((r: any) => ['verified', 'canonical'].includes(r.status))
        expect(active.some((r: any) => r.subject === 'entity:alpha' && r.content.includes('braun'))).toBe(true)
        expect(active.some((r: any) => r.subject === 'entity:alpha' && r.content.includes('Schopfhund'))).toBe(false)
        expect(active.some((r: any) => r.subject === 'entity:beta' && r.content.includes('Schopfhund'))).toBe(true)
        await h.close(); h = undefined
        h = await createE2EHarness({ reuseRoot: root })
        let recalledContext = ''
        const recalled = await h.telegram('Was weißt du über Alpha und Beta?', [call => {
            const system = call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
            recalledContext = system
            return { text: 'Alpha ist braun. Beta ist ein grauer Schopfhund.' }
        }])
        expect(recalled.error).toBeUndefined()
        expect(recalledContext).toContain('Alpha ist braun')
        expect(recalledContext).toContain('Beta ist ein grauer Schopfhund')
        expect(recalled.final).toContain('Alpha ist braun')
    }, 90_000)
})
