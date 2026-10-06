import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findeLoesung, HILFE_UNBEKANNT_ALLEIN, HILFE_UNBEKANNT_GEFRAGT, HILFE_UNBEKANNT_SCHON, ichKommNichtWeiter } from './stuck-helper.js'
import { hilfeView } from './telegram-guided.js'

// 2.86 Paket M Punkt 8: „Ich komm nicht weiter“ — vorhandene Diagnose, EINE Lösung in einem Satz + Knopf,
// sonst ehrlich „ich weiß es nicht, ich habe Claude gefragt“ über die vorhandene Delegation.

let dir: string
let t: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-help-')); t = Date.parse('2026-10-06T10:00:00.000Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const issue = (code: string, severity: 'error' | 'warning') => ({ code, severity, message: 'technisch' }) as any
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).filter(Boolean)

describe('Ich komm nicht weiter', () => {
    it('a Doctor error comes first: one sentence, one button', () => {
        const answer = findeLoesung({ diagnose: { issues: [issue('GPU_ACCELERATION_UNAVAILABLE', 'warning'), issue('OLLAMA_UNREACHABLE', 'error')] }, frage: { id: 'k000000000001', titel: 'ffmpeg?' } })!
        expect(answer.quelle).toBe('diagnose')
        expect(sentences(answer.satz)).toHaveLength(1)
        expect(answer.knopf).toEqual({ label: 'KI prüfen', aktion: { art: 'app', bereich: 'verbindungen' } })
    })

    it('then an expired login, then the waiting question, then the next setup step', () => {
        expect(findeLoesung({ verbindungen: [{ title: 'Google Kalender', status: 'abgelaufen' }], frage: { id: 'k1', titel: 'x' } })).toMatchObject({ quelle: 'verbindung', satz: expect.stringContaining('Google Kalender') })
        expect(findeLoesung({ frage: { id: 'k000000000001', titel: 'Hue Bridge koppeln?' } })).toMatchObject({ quelle: 'frage', knopf: { aktion: { art: 'frage-zeigen', cardId: 'k000000000001' } } })
        const next = findeLoesung({ einrichtung: { erledigt: 1, gesamt: 2, offen: [{ key: 'geraet:dev-00000000aa', titel: 'Home Assistant verbinden', erledigt: false, satz: 'Ich habe Home Assistant gefunden; ein Knopf, dann frage ich dich einmal.', knopf: { label: 'Verbinden', aktion: { art: 'verbinden', key: 'geraet:dev-00000000aa' } } }] } })!
        expect(next).toMatchObject({ quelle: 'einrichtung', knopf: { label: 'Verbinden', aktion: { art: 'verbinden', key: 'geraet:dev-00000000aa' } } })
        expect(findeLoesung({})).toBeNull()
    })

    it('nothing explains it: honest answer and ONE question to Claude (not again within 6 h)', async () => {
        const ask = vi.fn(async () => true)
        const deps = { dataDir: dir, now: () => t, quellen: async () => ({ diagnose: { issues: [] }, verbindungen: [], frage: null, einrichtung: { erledigt: 3, gesamt: 3, offen: [] } }), claudeFragen: ask }
        expect(await ichKommNichtWeiter(deps)).toEqual({ satz: HILFE_UNBEKANNT_GEFRAGT, quelle: 'claude' })
        expect(ask).toHaveBeenCalledOnce()
        const [auftrag, kontext] = ask.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(auftrag).toMatch(/^Untersuche/)
        expect(JSON.stringify(kontext)).not.toMatch(/token|passw|secret/i)
        t += 60 * 60_000
        expect(await ichKommNichtWeiter(deps)).toEqual({ satz: HILFE_UNBEKANNT_SCHON, quelle: 'claude' })
        expect(ask).toHaveBeenCalledOnce()
        t += 6 * 60 * 60_000
        await ichKommNichtWeiter(deps)
        expect(ask).toHaveBeenCalledTimes(2)
    })

    it('without a way to ask, she says so', async () => {
        const answer = await ichKommNichtWeiter({ dataDir: dir, now: () => t, quellen: async () => ({}), claudeFragen: async () => false })
        expect(answer).toEqual({ satz: HILFE_UNBEKANNT_ALLEIN, quelle: 'unbekannt' })
    })

    it('Telegram: one short message with at most one button', () => {
        const view = hilfeView('111', { satz: 'Die Anmeldung bei Google Kalender ist abgelaufen; unter „Verbindungen“ meldest du dich mit einem Knopf neu an.', knopf: { label: 'Verbindungen öffnen', aktion: { art: 'app', bereich: 'verbindungen' } }, quelle: 'verbindung' }, { dataDir: dir })
        expect(view.text.startsWith('💡 ')).toBe(true)
        expect(view.keyboard.flat()).toHaveLength(1)
    })
})
