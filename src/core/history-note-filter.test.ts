import { describe, expect, it } from 'vitest'
import { stripInternalHistoryNotes, withoutInternalNotes } from './history-note-filter.js'

describe('internal history notes never reach a user', () => {
    it('removes a copied note line and keeps the answer', () => {
        const text = 'Zum lab liegt kein Bild vor.\n\n[Verlaufsnotiz, nicht an den Nutzer gesendet — Werkzeuge: mesh_screenshot ok]'
        expect(stripInternalHistoryNotes(text)).toBe('Zum lab liegt kein Bild vor.')
    })
    it('removes a context line, also behind text on the same line', () => {
        expect(stripInternalHistoryNotes('Antwort A\n(Kontext: zuvor ausgeführt — Werkzeuge: x ok)\nAntwort B')).toBe('Antwort A\nAntwort B')
        expect(stripInternalHistoryNotes('Fertig. (Kontext: zuvor ausgeführt — Werkzeuge: x ok)')).toBe('Fertig.')
    })
    it('leaves normal text and normal parentheses alone', () => {
        const text = 'Wien (Hauptstadt von Österreich) hat rund 2 Mio. Einwohner.'
        expect(stripInternalHistoryNotes(text)).toBe(text)
    })
    it('the delivery wrapper cleans every message and never sends an empty one', async () => {
        const sent: string[] = []
        const send = withoutInternalNotes(async text => { sent.push(text) })
        await send('Hallo\n[Verlaufsnotiz — Werkzeuge: a]')
        await send('[Verlaufsnotiz — Werkzeuge: a]')
        expect(sent[0]).toBe('Hallo')
        expect(sent[1]).toMatch(/keine eigene Antwort/)
        expect(sent.join('\n')).not.toMatch(/Verlaufsnotiz/)
    })
})
