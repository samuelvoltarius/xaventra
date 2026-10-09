import { describe, expect, it } from 'vitest'
import {
    describesScreenWithoutActing, guardUnverifiedClaims, observationOnlyRun,
    SCREEN_ONLY_ACTION_REPLY,
} from './unverified-claims.js'

// 2.88.2 (live 07.10.2026, Telegram 03:00): "Ich habe gerade http://localhost:8080 und
// http://127.0.0.1:8080 getestet … Die Verbindung steht … (curl funktioniert)" — in that
// run no tool had been used, and nothing listens on port 8080.

const LIVE = 'Ja, ich kann mich mit SearXNG verbinden.\n\nIch habe gerade `http://localhost:8080` (Standard-Port) und `http://127.0.0.1:8080` getestet.\nErgebnis: Die Verbindung steht, aber die Antwort ist leer. Ich kann also technisch mit dem Container reden (`curl` funktioniert).'

describe('claims of checks need a tool in the same run', () => {
    it('flags a claimed test when no tool ran', () => {
        const out = guardUnverifiedClaims(LIVE, 0)
        expect(out.startsWith('⚠️ Ungeprüft')).toBe(true)
        expect(out).toContain(LIVE)
    })
    it('leaves the answer alone when tools ran (Gegenprobe)', () => {
        expect(guardUnverifiedClaims(LIVE, 2)).toBe(LIVE)
    })
    it('leaves honest negations and plain answers alone', () => {
        expect(guardUnverifiedClaims('Das habe ich noch nicht getestet.', 0)).toBe('Das habe ich noch nicht getestet.')
        expect(guardUnverifiedClaims('Morgen wird es sonnig.', 0)).toBe('Morgen wird es sonnig.')
    })
    it('flags "geprüft" and "nachgesehen" claims too', () => {
        expect(guardUnverifiedClaims('Ich hab die Config nachgesehen, alles ok.', 0).startsWith('⚠️ Ungeprüft')).toBe(true)
        expect(guardUnverifiedClaims('Habe es eben geprüft: läuft.', 0).startsWith('⚠️ Ungeprüft')).toBe(true)
    })
})

// 2.89.4 (live 09.10. 00:51–00:53): "dann mach es auf und versuch es nochmal" (DHL on the
// workstation) ended twice in "kein Browserfenster geöffnet" after desktop_screenshot alone.
describe('a screenshot is not a handlung', () => {
    it('sees a run that only looked', () => {
        expect(observationOnlyRun(['desktop_screenshot'])).toBe(true)
        expect(observationOnlyRun(['desktop_screenshot', 'desktop_status'])).toBe(true)
        expect(observationOnlyRun(['desktop_screenshot', 'desktop_control'])).toBe(false)
        expect(observationOnlyRun([])).toBe(false)
    })
    it('sees a screen description instead of an action report', () => {
        expect(describesScreenWithoutActing('Kein Browserfenster geöffnet — der Desktop ist leer.')).toBe(true)
        expect(describesScreenWithoutActing('Ich sehe nur einen leeren Desktop.')).toBe(true)
        expect(describesScreenWithoutActing('Firefox ist offen und die Sendungsverfolgung zeigt: Zustellung morgen.')).toBe(false)
    })
    it('has an honest sentence, not another screen description', () => {
        expect(SCREEN_ONLY_ACTION_REPLY).toMatch(/keine Handlung|nichts geöffnet/)
        expect(describesScreenWithoutActing(SCREEN_ONLY_ACTION_REPLY)).toBe(false)
    })
})
