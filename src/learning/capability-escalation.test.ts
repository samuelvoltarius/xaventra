import { describe, expect, it, vi } from 'vitest'
import {
    capabilityEscalationPrompt, detectsFalseDenial, directLookupUrls, escalationChain, formatDenialCorrection,
    isBrowserMissingError, noteUiGap, rewriteFalseDenial, runUiEscalation, stripFalseDenialSentences,
    uiToolViewFromInventory, uiToolViewFromTools,
} from './capability-escalation.js'
import { capabilityHonestyPrompt } from './capability-learning.js'
import { recordCapabilityNeed, readCapabilityNeedSignals } from '../install/software-demand.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 2.89.4 (Live 09.10.2026): „Ich habe kein echtes Maus-Werkzeug … entzieht sich
// jedem automatischen Zugriff“ bei DHL-Tracking. Die Nummer geht zuerst in den
// URL-Parameter, dann Browser (Warten + Eingabe), dann Desktop-Computer-Use.
// Fake-Page: nur fetchPage ist gespielt — die Kette selbst ist echt.

const LIVE_DENIAL = 'Das Formular ist dynamisch. Ich habe kein echtes Maus-Werkzeug und die Seite entzieht sich jedem automatischen Zugriff.'
// Frei erfundene Testnummer (192.0.2.0/TEST-NET-1-Stil), kein echter Sendungsbeleg.
const TRACKING = 'TEST19202000001'
const DHL = 'https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html'

describe('falsche „unmöglich“-Behauptung erkennen', () => {
    it('findet den Live-Satz und enge Verwandte, nicht die ehrliche Formel', () => {
        expect(detectsFalseDenial(LIVE_DENIAL)).toBe(true)
        expect(detectsFalseDenial('Ich habe kein echtes Maus-Werkzeug.')).toBe(true)
        expect(detectsFalseDenial('Die Seite ist nicht automatisierbar.')).toBe(true)
        expect(detectsFalseDenial('Nein, das kann ich noch nicht. Soll ich es lernen?')).toBe(false)
        expect(detectsFalseDenial('Direktlink hat keinen Treffer geliefert; Browser und Desktop laufen noch.')).toBe(false)
    })

    it('entfernt die falschen Sätze und behält den Rest der Antwort', () => {
        const cleaned = stripFalseDenialSentences(`${LIVE_DENIAL} Die Nummer war ${TRACKING}.`)
        expect(cleaned).not.toMatch(/Maus-Werkzeug|entzieht sich/)
        expect(cleaned).toContain(TRACKING)
    })
})

describe('Kette und Korrekturtext', () => {
    it('benennt immer alle drei Stufen und nie „unmöglich“', () => {
        const note = formatDenialCorrection(uiToolViewFromTools(['browser_navigate', 'desktop_input', 'fetch_url']))
        expect(note).toContain('Direktlink/Fetch')
        expect(note).toContain('Browser')
        expect(note).toContain('Desktop-Computer-Use')
        expect(note).not.toMatch(/unm(?:ö|oe)glich/i)
        expect(note).toContain('Hier belegt')
    })

    it('Browser-Lücke ist Bedarf, keine Unmöglichkeit', () => {
        const note = formatDenialCorrection(uiToolViewFromTools(['fetch_url']))
        expect(note).toContain('Bedarf')
        expect(note).toContain('Chromium')
        expect(note).not.toMatch(/entzieht sich jedem automatischen Zugriff/)
    })

    it('rewriteFalseDenial ersetzt den Live-Satz; unverdächtige Antworten bleiben', () => {
        const rewritten = rewriteFalseDenial(LIVE_DENIAL, { tools: ['browser_type', 'desktop_input', 'fetch_url'] })
        expect(rewritten).toBeTruthy()
        expect(rewritten).not.toMatch(/Maus-Werkzeug/)
        expect(rewritten).toContain('Korrektur')
        expect(rewritten).toContain('Browser')
        expect(rewriteFalseDenial('Der Stand ist unverändert.', { tools: ['browser_type'] })).toBeNull()
    })

    it('Prompt und capabilityHonestyPrompt verlangen die Kette', () => {
        const chain = capabilityEscalationPrompt()
        expect(chain).toContain('Direktlink')
        expect(chain).toContain('browser_type')
        expect(chain).toContain('desktop_input')
        expect(chain).toMatch(/NIE „kein Maus-Werkzeug“/)
        const honesty = capabilityHonestyPrompt()
        expect(honesty).toContain('Eskalationskette')
        expect(honesty).toContain('Soll ich es lernen')
    })

    it('uiToolViewFromInventory zählt auch kaputte Browser-Werkzeuge nicht als da', () => {
        const view = uiToolViewFromInventory({
            tools: ['browser_navigate', 'desktop_screenshot', 'fetch_url'],
            connected: new Set(),
            learned: [],
            brokenTools: new Set(['browser_navigate']),
        })
        expect(view.steps).toEqual(['direktlink', 'desktop'])
        expect(view.browserMissing).toBe(true)
        expect(escalationChain(view)).toEqual(['direktlink', 'desktop'])
    })
})

describe('Direktlink-Kandidaten (Tracking-Nummer im URL-Parameter)', () => {
    it('baut DHL- und generische tracking-id-Links', () => {
        const urls = directLookupUrls(DHL, TRACKING)
        expect(urls.some(url => url.includes(`piececode=${TRACKING}`))).toBe(true)
        expect(urls.some(url => url.includes(`tracking-id=${TRACKING}`))).toBe(true)
        expect(urls.some(url => url.startsWith('https://www.dhl.de/'))).toBe(true)
        const generic = directLookupUrls('https://example.test/track', TRACKING)
        expect(generic.some(url => url.includes('example.test/track?tracking-id='))).toBe(true)
        expect(directLookupUrls(DHL, '')).toEqual([])
    })
})

describe('Kette mit Fake-Page', () => {
    it('Stufe 1: Direktlink liefert den Beleg — Browser/Desktop nie nötig', async () => {
        const fetchPage = vi.fn(async (url: string) => url.includes(`piececode=${TRACKING}`)
            ? { ok: true, text: `Sendung ${TRACKING}: zugestellt` }
            : { ok: false, text: 'Startseite' })
        const browserNavigate = vi.fn()
        const desktopInput = vi.fn()
        const result = await runUiEscalation({ url: DHL, id: TRACKING }, {
            fetchPage, browserNavigate, desktopInput,
            view: uiToolViewFromTools(['fetch_url', 'browser_navigate', 'desktop_input', 'parcel_track']),
        })
        expect(result.ok).toBe(true)
        expect(result.step).toBe('direktlink')
        expect(result.reply).toContain('Direktlink')
        expect(result.reply).not.toMatch(/unm(?:ö|oe)glich|Maus-Werkzeug/)
        expect(fetchPage).toHaveBeenCalled()
        expect(browserNavigate).not.toHaveBeenCalled()
        expect(desktopInput).not.toHaveBeenCalled()
    })

    it('Stufe 2: Fake-Page ohne URL-Treffer, Browser mit Warten + Eingabe schlägt an', async () => {
        const typed: string[] = []
        const result = await runUiEscalation({
            url: 'https://example.test/suche', id: TRACKING, inputSelector: '#tracking',
        }, {
            fetchPage: async () => ({ ok: false, text: 'leeres Suchformular' }),
            browserNavigate: async () => undefined,
            browserWait: async () => undefined,
            browserType: async (text: string) => { typed.push(text) },
            browserClick: async () => undefined,
            browserExtract: async () => `Ergebnis für ${TRACKING}: in transit`,
            view: uiToolViewFromTools(['browser_navigate', 'browser_type', 'browser_extract']),
        })
        expect(result.ok).toBe(true)
        expect(result.step).toBe('browser')
        expect(typed).toEqual([TRACKING])
        expect(result.reply).toContain('Browser')
    })

    it('Stufe 3: Browser ohne Chromium → Bedarf, Desktop-Computer-Use übernimmt', async () => {
        const gaps: Array<{ kind: string; detail: string }> = []
        const actions: Array<Record<string, unknown>> = []
        const result = await runUiEscalation({ url: DHL, id: TRACKING }, {
            fetchPage: async () => ({ ok: false }),
            browserNavigate: async () => { throw new Error('playwright chromium executable doesn\'t exist') },
            desktopScreenshot: async () => undefined,
            desktopInput: async action => { actions.push(action) },
            view: uiToolViewFromTools(['browser_navigate', 'desktop_input', 'desktop_screenshot']),
            noteGap: (kind, detail) => gaps.push({ kind, detail }),
        })
        expect(result.ok).toBe(true)
        expect(result.step).toBe('desktop')
        expect(gaps).toEqual([{ kind: 'browser', detail: expect.stringContaining('chromium') }])
        expect(actions.some(action => action.action === 'type')).toBe(true)
        expect(result.reply).not.toMatch(/unm(?:ö|oe)glich|entzieht sich/)
        expect(isBrowserMissingError(new Error('playwright chromium executable doesn\'t exist'))).toBe(true)
    })

    it('alle Stufen gescheitert: ehrliches Ergebnis mit Lücke, nie „unmöglich“', async () => {
        const result = await runUiEscalation({ url: DHL, id: TRACKING }, {
            fetchPage: async () => ({ ok: false, text: '' }),
            browserNavigate: async () => { throw new Error('playwright chromium nicht installiert') },
            view: uiToolViewFromTools(['browser_navigate']),
        })
        expect(result.ok).toBe(false)
        expect(result.step).toBe('keiner')
        expect(result.reply).toContain('ehrliche')
        expect(result.reply).toContain('Bedarf')
        expect(result.reply).not.toMatch(/entzieht sich jedem automatischen Zugriff|kein Maus-Werkzeug|unm(?:ö|oe)glich/i)
    })
})

describe('Lücke als Bedarf (Software-Scout)', () => {
    it('Browser-Fehl-Signal landet im Bedarfs-File, nicht als Unmöglichkeit', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'esc-bedarf-')), 'signal.json')
        recordCapabilityNeed('browser', 'browser-fehlt', { path, now: Date.parse('2026-10-09T10:00:00Z') })
        recordCapabilityNeed('desktop', 'desktop-eingabe-fehlt', { path, now: Date.parse('2026-10-09T10:00:00Z') })
        const signals = readCapabilityNeedSignals({ path, now: Date.parse('2026-10-09T10:05:00Z') })
        expect(signals.map(item => item.capability).sort()).toEqual(['browser', 'desktop'])
        expect(signals.map(item => item.detail).join(' ')).toMatch(/Bedarf|fehlt/i)
    })

    it('noteUiGap wirft nie', () => {
        expect(() => noteUiGap('browser', 'chromium missing')).not.toThrow()
    })
})
