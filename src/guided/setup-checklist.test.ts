import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChecklist, collectChecklist, factsFromOverview, skipChecklistItem, startChecklistItem } from './setup-checklist.js'
import { checklistView, pressGuided } from './telegram-guided.js'
import { runGuidedAction } from './guided-runtime.js'

// 2.86 Paket M Punkt 1: Einrichtungs-Checkliste aus echten Zuständen, ein Knopf je offenem Punkt.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-setup-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const found = (over: Record<string, unknown>) => ({ id: 'x', title: 'X', kategorie: 'geraete', wirkung: '', fund: '', verbunden: false, ...over }) as any
function overview(state: { ha?: boolean; hue?: boolean } = {}) {
    return {
        gefunden: [
            found({ id: 'ki-modelle:local', title: 'Lokales Modell', kategorie: 'ki-modelle', verbunden: true }),
            found({ id: 'geraet:homeassistant:192.0.2.10:8123', title: 'Home Assistant', kategorie: 'zuhause', connectorId: 'home-assistant', verbunden: state.ha === true, geraet: { id: 'dev-00000000aa', verbinden: 'homeassistant', dienste: 1 } }),
            found({ id: 'geraet:hue:192.0.2.11:80', title: 'Hue Bridge', kategorie: 'zuhause', verbunden: state.hue === true, geraet: { id: 'dev-00000000bb', verbinden: 'hue', dienste: 1 } }),
            // no way to connect → never a checklist item
            found({ id: 'geraet:networkdevice:192.0.2.12:0', title: 'LAN-Gerät', geraet: { id: 'dev-00000000cc', verbinden: null, dienste: 1 } }),
        ],
        verbunden: [{ id: 'c-cal', connectorId: 'google-calendar', title: 'Google Kalender', status: 'verbunden' }] as any[],
    }
}

describe('Einrichtungs-Checkliste', () => {
    it('is derived from real state: 2 von 5, one button per open item', () => {
        const list = buildChecklist(factsFromOverview(overview(), { telegramGekoppelt: false }))
        expect(list.kopf).toBe('2 von 5 erledigt')
        expect(list.punkte.map(item => [item.titel, item.erledigt])).toEqual([
            ['KI-Modell läuft', true], ['Telegram koppeln', false], ['Home Assistant verbinden', false], ['Hue Bridge verbinden', false], ['Google Kalender', true],
        ])
        for (const item of list.offen) expect(item.knopf).toBeDefined()
        expect(list.offen.map(item => item.knopf!.aktion)).toEqual([{ art: 'app', bereich: 'start' }, { art: 'verbinden', key: 'geraet:dev-00000000aa' }, { art: 'verbinden', key: 'geraet:dev-00000000bb' }])
        expect(list.fertig).toBe(false)
    })

    it('ticks itself when something gets connected and disappears when everything is done', () => {
        const half = buildChecklist(factsFromOverview(overview({ ha: true }), { telegramGekoppelt: true }))
        expect(half.kopf).toBe('4 von 5 erledigt')
        expect(half.punkte.find(item => item.key === 'geraet:dev-00000000aa')).toMatchObject({ titel: 'Home Assistant', erledigt: true })
        const done = buildChecklist(factsFromOverview(overview({ ha: true, hue: true }), { telegramGekoppelt: true }))
        expect(done).toMatchObject({ fertig: true, offen: [], kopf: '5 von 5 erledigt' })
    })

    it('„Nicht nötig“ removes an item for good; „Verbinden“ opens the existing question only', async () => {
        expect(skipChecklistItem('geraet:dev-00000000bb', { dataDir: dir }).ok).toBe(true)
        expect(skipChecklistItem('../etc', { dataDir: dir }).ok).toBe(false)
        const offerDevice = vi.fn(async () => ({ ok: true, message: 'Karte' }))
        const requestConnect = vi.fn(async () => ({ ok: true, message: 'Karte' }))
        const deps = { dataDir: dir, overview: async () => overview(), telegramGekoppelt: () => true, offerDevice, requestConnect }
        const list = await collectChecklist(deps)
        expect(list.punkte.some(item => item.key === 'geraet:dev-00000000bb')).toBe(false)
        expect(list.kopf).toBe('3 von 4 erledigt')
        const started = await startChecklistItem('geraet:dev-00000000aa', deps)
        expect(started.ok).toBe(true)
        expect(offerDevice).toHaveBeenCalledWith('dev-00000000aa')
        expect(requestConnect).not.toHaveBeenCalled()
        // an item that is already done does nothing
        expect((await startChecklistItem('ki', deps)).ok).toBe(false)
    })

    it('Telegram: one short message, one main button per open item (owner only, chat bound)', async () => {
        const list = buildChecklist(factsFromOverview(overview(), { telegramGekoppelt: false }))
        const view = checklistView('111', list, { dataDir: dir })
        expect(view.text.length).toBeLessThanOrEqual(600)
        expect(view.text).toMatch(/^🧭 Einrichtung: 2 von 5 erledigt/)
        expect(view.text).toContain('✓ KI-Modell läuft')
        expect(view.text).toContain('▢ Hue Bridge verbinden')
        expect(view.keyboard).toHaveLength(3)
        expect(view.keyboard.map(row => row[0].text)).toEqual(['Koppeln: Telegram koppeln', 'Verbinden: Home Assistant', 'Verbinden: Hue Bridge'])
        for (const button of view.keyboard.flat()) expect(button.callback_data).toMatch(/^gf:[a-f0-9]{16}$/)
        const hue = view.keyboard[2][0].callback_data
        expect(pressGuided(hue, { userId: '222', ownerIds: ['111'], chatId: '111' }, { dataDir: dir }).ok).toBe(false)
        expect(pressGuided(hue, { userId: '111', ownerIds: ['111'], chatId: '999' }, { dataDir: dir }).ok).toBe(false)
        const pressed = pressGuided(hue, { userId: '111', ownerIds: ['111'], chatId: '111' }, { dataDir: dir })
        expect(pressed.aktion).toEqual({ art: 'einrichten', key: 'geraet:dev-00000000bb' })
        const offerDevice = vi.fn(async () => ({ ok: true, message: 'Karte' }))
        const result = await runGuidedAction(pressed.aktion!, { chatId: '111', by: 'telegram:111' }, { dataDir: dir, checklist: { overview: async () => overview(), telegramGekoppelt: () => false, offerDevice } })
        expect(result).toMatchObject({ ok: true, weiter: true })
        expect(offerDevice).toHaveBeenCalledWith('dev-00000000bb')
    })

    it('a finished list is one line without buttons', () => {
        const view = checklistView('111', buildChecklist(factsFromOverview(overview({ ha: true, hue: true }), { telegramGekoppelt: true })), { dataDir: dir })
        expect(view).toEqual({ text: '✅ Alles eingerichtet (5 von 5 erledigt).', keyboard: [] })
    })
})
