import { describe, expect, it } from 'vitest'
import { isTelegramFailureReply } from './telegram-presentation.js'
import { limitStopNotice } from '../core/run-limits.js'
import { unfinishedRunNotice } from '../core/tool-evidence-response.js'
import { honestNoToolResponse } from '../core/action-intent.js'
import { userFacingVerdictMessage } from '../core/task-contract.js'

// 2.90.1 (Codekarte D3): "Die Aktion ist nicht gelungen …", "nicht hinbekommen", "nicht als abgeschlossen
// bestätigen" and the limit texts closed the status card as success. The texts come from their real producers.
describe('the Telegram status card recognises the canonical failure texts', () => {
    const limits = { maxToolRounds: 12, toolTimeoutMs: {} } as any
    it.each([
        ['escalation', 'Die Aktion ist nicht gelungen. Ich habe die Ursache intern zur Prüfung vorgemerkt; es wurde keine Änderung ausgeführt.'],
        ['no tool', honestNoToolResponse('action' as any)],
        ['contract', userFacingVerdictMessage(['response is empty'], [])],
        ['unfinished', unfinishedRunNotice()],
        ['rounds', limitStopNotice(new Error('MaxTurnsExceeded'), limits)],
        ['tool timeout', limitStopNotice(new Error('[Timeout] Tool: hass_list exceeded 30000ms'), limits)],
        ['deadline', limitStopNotice(new Error('Task execution deadline exceeded'), limits)],
        ['budget', limitStopNotice(new Error('tool-call budget exhausted'), limits)],
        ['peer timeout', 'Das hat zu lange gedauert, ich war nicht rechtzeitig fertig.'],
    ])('%s', (_name, text) => {
        expect(text).toBeTruthy()
        expect(isTelegramFailureReply(text)).toBe(true)
    })

    it('a partial result with a later failure and a normal answer stay successful', () => {
        expect(isTelegramFailureReply('Gelesen: Surfmate State of charge: 97.0 %.\n\nEin späterer Schritt ist danach nicht gelungen; die Ursache ist intern zur Prüfung vorgemerkt. Geändert wurde nichts.')).toBe(false)
        expect(isTelegramFailureReply('Der Akku steht bei 97 %. Die Heizung ist nicht gelungen zu starten, war aber nicht gefragt.')).toBe(false)
    })
})
