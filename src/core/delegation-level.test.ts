import { describe, expect, it } from 'vitest'
import { classifyDelegationLevel } from './delegation.js'

// L1 (goes out without a card) only for clearly read-only work. Everything that
// creates, writes, moves, sends, prints, switches or buys needs the owner's Ja (L2).
describe('Delegation: Stufe nach Erlaubnisliste', () => {
    it.each([
        'Schreib die Config neu',
        'Erstelle eine neue VM',
        'Leg einen Cronjob an',
        'Verschiebe die Dateien nach /opt',
        'Setz das um',
        'Sende Alfred eine Mail',
        'Schalte den Drucker ein',
        'Kauf ein neues Netzteil',
        'Bestell Filament nach',
        'Führe das Skript aus',
        'Mach das bitte',
        'Prüfe die CI und erstelle dann ein Ticket',
    ])('„%s“ ist L2', auftrag => {
        expect(classifyDelegationLevel(auftrag).stufe).toBe('L2')
    })

    it.each([
        'Prüfe die CI von ed2a6e6',
        'Analysiere den Log',
        'Recherchiere neue vLLM-Modelle für den Spark',
        'Fasse die Mail von gestern zusammen',
        'Vergleiche qwen mit dem neuen Modell',
        'Untersuche, warum web_search langsam ist',
    ])('„%s“ bleibt L1', auftrag => {
        expect(classifyDelegationLevel(auftrag).stufe).toBe('L1')
    })
})
