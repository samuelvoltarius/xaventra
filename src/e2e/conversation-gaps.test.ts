/**
 * 2.89.3 Gespraechstest-Befunde ueber den echten Telegram-Eingang (nur das Modell ist gespielt):
 * Kurzantworten gelten als Antwort und verwerfen nie den Verlauf, Rueckbezug auf das Gespraech,
 * "angekuendigt, nicht getan", Plauderfragen ohne Gedaechtnis-/Introspektions-Werkzeuge.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { superviseResponse } from '../layers/L0-supervisor.js'
import { groundedInConversation } from '../layers/L12-anti-hallucination.js'
import { announcesUnperformedAction, ANNOUNCED_BUT_NOT_DONE_REPLY } from '../core/unverified-claims.js'
import { hasUsableToolEvidence } from '../core/tool-evidence-response.js'
import { primaryLlmTimeoutMs } from '../agents/nova-runner.js'
import { getRelevantTools } from '../tools/tool-router.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

describe('2.89.3 L0: Kurzantworten', () => {
    it.each(['56', 'Ja', '4', 'OK', '7'])('„%s“ ist eine vollständige Antwort', text => {
        const result = superviseResponse(text, { attempt: 1 })
        expect(result.needsRetry).toBe(false)
        expect(result.content).toBe(text)
    })
    it('leer = kein sichtbares Zeichen: höchstens Wiederholung, nie Sitzungs-Reset', () => {
        for (const attempt of [1, 2, 3]) {
            const result = superviseResponse(' ​\n', { attempt })
            expect(result.shouldResetSession).toBe(false)
            expect(result.needsRetry).toBe(attempt < 3)
        }
    })
})

describe('2.89.3 Bausteine', () => {
    it('L12: Namen und Zahlen aus dem Gesprächsverlauf sind belegt', () => {
        const history = ['Nutzer: Mein Hund heißt Bruno und ist 4', 'Assistent: Schön, Bruno klingt nett!']
        expect(groundedInConversation('Dein Hund heißt Bruno.', history)).toBe(true)
        expect(groundedInConversation('Er ist 4.', history)).toBe(true)
        expect(groundedInConversation('Dein Hund heißt Rex.', history)).toBe(false)
        expect(groundedInConversation('Dein Hund heißt Bruno.', [])).toBe(false)
    })
    it('„keine Treffer“ ist kein verwertbares Werkzeugergebnis', () => {
        expect(hasUsableToolEvidence([{ toolName: 'kg_search', success: true, result: 'Keine Treffer im Knowledge Graph.' }])).toBe(false)
        expect(hasUsableToolEvidence([{ toolName: 'weather', success: true, result: '14 Grad, bedeckt' }])).toBe(true)
    })
    it('Ankündigung ohne Ergebnis wird erkannt, Antwort mit Ziffern nicht', () => {
        expect(announcesUnperformedAction('Ich rufe kurz die aktuelle Zeit ab …')).toBe(true)
        expect(announcesUnperformedAction('Einen Moment, ich schaue kurz nach.')).toBe(true)
        expect(announcesUnperformedAction('In Tokio ist es 02:08 Uhr.')).toBe(false)
        expect(announcesUnperformedAction('Das Wetter ist schön.')).toBe(false)
    })
})

describe('2.89.3 über den echten Eingang', () => {
    it('kurzantwort: „Was ist 8 mal 7?“ → „56“, danach bleibt der Verlauf erhalten', async () => {
        h = await createE2EHarness()
        const first = await h.telegram('Was ist 8 mal 7?', [{ text: '56' }])
        expect(first.final).toBe('56')
        expect(first.final).not.toMatch(/keine Antwort generieren/)
        const second = await h.telegram('und 9 mal 6?', [{ text: '54' }])
        expect(second.final).toBe('54')
        const seen = JSON.stringify(second.rounds[0]?.messages ?? [])
        expect(seen).toContain('8 mal 7')
    }, T)

    it('rueckbezug-hund: Antwort aus dem Verlauf, keine rohe Werkzeug-Ausgabe, Gedächtnis-Werkzeuge nicht im ersten Angebot', async () => {
        h = await createE2EHarness()
        await h.telegram('Mein Hund heißt Bruno und ist 4', [{ text: 'Schön, Bruno klingt nett!' }])
        const result = await h.telegram('wie hieß mein Hund?', [{ text: 'Dein Hund heißt Bruno und ist 4.' }])
        expect(result.offeredTools).not.toContain('kg_search')
        expect(result.final).toMatch(/Bruno/)
        expect(result.final).not.toMatch(/kg_search|Keine Treffer/)
    }, T)

    it('rueckbezug-hund: ruft das Modell trotzdem kg_search (leer), bleibt „Bruno“ stehen', async () => {
        h = await createE2EHarness()
        await h.telegram('Mein Hund heißt Bruno und ist 4', [{ text: 'Schön, Bruno klingt nett!' }])
        const result = await h.telegram('wie hieß mein Hund?', [
            { tool: 'kg_search', args: { query: 'Hund' } },
            { text: 'Dein Hund heißt Bruno.' },
        ])
        expect(result.final).toMatch(/Bruno/)
        expect(result.final).not.toMatch(/kg_search:|Keine Treffer/)
    }, T)

    it('folge-tokio: angekündigt, nicht getan → Werkzeug wird nachgefordert und das Ergebnis geliefert', async () => {
        h = await createE2EHarness()
        await h.telegram('Wie spät ist es?', [{ tool: 'get_current_time', args: {} }, { text: 'Es ist 19:08 Uhr.' }])
        const result = await h.telegram('und in Tokio?', [
            { text: 'Ich rufe kurz die aktuelle Zeit ab …' },
            { tool: 'get_current_time', args: { timezone: 'Asia/Tokyo' } },
            { text: 'In Tokio ist es 02:08 Uhr.' },
        ])
        expect(result.final).toMatch(/02:08/)
        expect(result.final).not.toMatch(/Ich rufe kurz/)
    }, T)

    it('folge-tokio: bleibt es bei der Ankündigung, kommt ein ehrlicher Satz statt des leeren Versprechens', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('und in Tokio?', [
            { text: 'Ich rufe kurz die aktuelle Zeit ab …' },
            { text: 'Einen Moment, ich schaue nach.' },
        ])
        expect(result.final).toBe(ANNOUNCED_BUT_NOT_DONE_REPLY)
    }, T)

    it('Plauderfrage: keine Gedächtnis-/Introspektions-Werkzeuge im ersten Angebot', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('was machst du den ganzen Tag?', [{ text: 'Ich warte auf deine nächste Frage und sortiere Gedanken.' }])
        expect(result.offeredTools).not.toContain('kg_search')
        expect(result.offeredTools).not.toContain('nova_introspect')
        expect(result.final).toMatch(/warte/)
    }, T)
})

describe('2.89.3 lange Eingabe, langsames Modell', () => {
    it('Modell-Zeitlimit wächst mit Prompt und Werkzeugen, bleibt auf 150 s begrenzt', () => {
        expect(primaryLlmTimeoutMs(5_000, 5)).toBe(60_000)
        expect(primaryLlmTimeoutMs(40_000, 31)).toBeGreaterThan(60_000)
        expect(primaryLlmTimeoutMs(2_000_000, 40)).toBe(150_000)
    })

    const FILLER = 'Der Tarif umfasst Speicher, Support und ein Update-Konzept für alle Geräte im Haushalt. '.repeat(14)
    const PASTED = `Anbieter-Info:
${FILLER}
Skills, Lernen, Schmiede und Erweiterungen sind optional.
${FILLER}
Bitte fasse das kurz zusammen.`

    it('langer eingefügter Text aktiviert keine Pakete durch zufällige Wörter in der Mitte', () => {
        const names = getRelevantTools(PASTED).map(tool => tool.name)
        expect(names).not.toContain('build_skill')
        expect(names.length).toBeLessThan(15)
    })

    it('langer Text + langsames Modell: Antwort kommt, nicht die interne Zeitüberschreitungs-Meldung', async () => {
        h = await createE2EHarness()
        const result = await h.telegram(PASTED, [{ delayMs: 1500, then: { text: 'Kurz gesagt: ein Tarif mit Speicher, Support und Updates.' } }])
        expect(result.final).toMatch(/Tarif/)
        expect(result.final).not.toMatch(/Modell-Routen|nicht rechtzeitig/)
    }, T)
})
