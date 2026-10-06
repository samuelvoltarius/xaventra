import { describe, expect, it } from 'vitest'
import { detectDeterministicCommand } from './deterministic-query.js'

// 2.86 Paket N: Schalt- und Routinensätze gehen deterministisch an /geraete —
// dort entsteht nur eine Vorschau-Karte (physisch = Karte, Policy unverändert).
describe('Geräte-Sätze ohne Modell', () => {
    it.each([
        ['Licht im Wohnzimmer aus', 'sag Licht im Wohnzimmer aus'],
        ['Mach bitte das Wohnzimmerlicht aus!', 'sag Mach bitte das Wohnzimmerlicht aus!'],
        ['schalte die Stehlampe ein', 'sag schalte die Stehlampe ein'],
        ['alles aus', 'sag alles aus'],
        ['Jeden Abend um 23 Uhr alles aus', 'sag Jeden Abend um 23 Uhr alles aus'],
    ])('%s → /geraete %s', (text, args) => {
        expect(detectDeterministicCommand(text)).toEqual({ command: 'geraete', args, reason: 'device-switch-preview', risk: 'controlled-action' })
    })

    it('Routinen-Liste ist lesend', () => {
        expect(detectDeterministicCommand('Zeig mir meine Geräte-Routinen')).toEqual({ command: 'geraete', args: 'routinen', reason: 'device-routines', risk: 'read-only' })
    })

    it.each(['Ist das Licht im Wohnzimmer aus?', 'ich gehe heute aus', 'es ist alles aus', 'Stehlampe aus', 'Wie mache ich das Licht aus', 'Was machst du jeden Abend um 23 Uhr?'])('kein Schaltbefehl: %s', text => {
        expect(detectDeterministicCommand(text)?.command).not.toBe('geraete')
    })
})
