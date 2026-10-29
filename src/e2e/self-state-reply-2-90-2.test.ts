/**
 * 2.90.2 (Abnahme 2.90.1, 29.10. 18:22:48): "wie geht's dir?" two minutes after the update. The model answered
 * without tools (253 chars, SelfCheck ok); the reply sent was "Das habe ich gerade nicht hinbekommen und nichts
 * verändert …" because "ich wurde gerade neu gestartet" counted as a claimed completed action. A statement about
 * Xaventra's own restart or update is no claim of an action the owner asked for.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { responseClaimsCompletedAction } from '../core/action-intent.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

const AFTER_RESTART = 'Mir geht es gut, danke! Ich wurde gerade erst neu gestartet und laufe jetzt auf der neuen Version. Telegram ist verbunden, MiniMax antwortet, keine Fehler seit dem Start. Womit kann ich dir helfen?'

describe('a self-state answer right after an update stays', () => {
    it('"wie geht\'s dir?" keeps the model answer over the real entry', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram("wie geht's dir?", [{ text: AFTER_RESTART }])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('Mir geht es gut')
        expect(result.final).not.toMatch(/nicht hinbekommen/)
    }, 120_000)

    it.each([
        'Ich wurde gerade erst neu gestartet.',
        'Ich bin seit zwei Minuten wieder online, das Update wurde eingespielt und alle Dienste sind gestartet.',
        'Xaventra wurde vorhin aktualisiert und läuft.',
    ])('"%s" is no action claim', text => expect(responseClaimsCompletedAction(text)).toBe(false))

    it.each([
        'Ich habe die Datei gelöscht.',
        'Die Nachricht wurde gerade gesendet.',
        'Ich habe den Server neu gestartet.',
        'Der Dienst wurde gestartet.',
    ])('"%s" still is one', text => expect(responseClaimsCompletedAction(text)).toBe(true))
})
