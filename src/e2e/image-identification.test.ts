/**
 * 2.89.2 (live 08.10.2026): a guessed "Wischernebel (NGC 6960)" for Ou4 in Sh2-129 reached the owner as
 * fact. Over the real Telegram entry with a picture and a scripted model.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { guardImageIdentification } from '../core/image-identification.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const PNG = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', mimeType: 'image/png' }
const T = 60_000

describe('2.89.2 picture identification without evidence', () => {
    it('Telegram picture + „Was ist das“: a confident guess carries the reservation', async () => {
        h = await createE2EHarness()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'Was ist das', [
            { text: 'Das ist der Wischernebel (NGC 6960), Teil des Cygnus Loop.' },
        ], { image: PNG, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('Wischernebel')
        expect(result.final).toMatch(/Nicht belegt/)
        expect(result.final).toMatch(/sicher bin ich nicht/)
        expect(result.final).toMatch(/Plate-Solving/)
    }, T)

    it('incident shape (kg_search only, L12 fail-open): the reservation does not depend on the fact-check', async () => {
        h = await createE2EHarness()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'Was ist das', [
            { tool: 'kg_search', args: { query: 'Nebel' } },
            { text: 'Es handelt sich um den Wischernebel (NGC 6960).' },
        ], { image: PNG, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/Nicht belegt/)
    }, T)

    it('astro_plate_solve without a solver: honest learn question', async () => {
        h = await createE2EHarness()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'Bestimme den Nebel auf diesem Bild per plate solving', [
            { tool: 'astro_plate_solve', args: { image_path: 'F:/nope/example.jpg' } },
            { text: 'Das ist der Wischernebel.' },
        ], { image: PNG, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        expect(result.error).toBeUndefined()
        expect(result.final).toMatch(/Soll ich es lernen\?/)
        expect(result.final).toMatch(/kann ich noch nicht/i)
    }, T)

    it('guard unit: hedged reply and proven identification pass unchanged', () => {
        const base = { hasImage: true, question: 'Was ist das', solverInstalled: true }
        const hedged = 'Sieht für mich aus wie der Wischernebel, sicher bin ich nicht.'
        expect(guardImageIdentification({ ...base, reply: hedged })).toBe(hedged)
        const solved = 'Das ist der Wischernebel.'
        expect(guardImageIdentification({ ...base, reply: solved, evidence: { identified: true, plateSolveMissing: false } })).toBe(solved)
        expect(guardImageIdentification({ ...base, hasImage: false, reply: solved })).toBe(solved)
        expect(guardImageIdentification({ ...base, reply: 'Das ist eine Eiche.' })).toMatch(/Nicht belegt/)
    })
})
