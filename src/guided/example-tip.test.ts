import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BEISPIELSAETZE, beispielSaetze, noteConnected, offeneBeispiele } from './example-prompts.js'
import { tippAblehnen, tippHeute, TIPPS } from './daily-tip.js'
import { runGuidedAction, runGuidedTelegramTick } from './guided-runtime.js'
import { pressGuided } from './telegram-guided.js'
import { listDecisions } from '../core/decisions.js'
import { zonedHour } from '../planner/time.js'

// 2.86 Paket M Punkt 3 (drei Beispielsätze) und Punkt 10 (höchstens ein Tipp am Tag).

let dir: string
let t: number
const HOUR = 60 * 60_000
const opts = () => ({ dataDir: dir, now: () => t })
const ha = { id: 'geraet:homeassistant:192.0.2.10:8123', title: 'Home Assistant', connectorId: 'home-assistant', kategorie: 'zuhause' }
const ki = { id: 'ki-modelle:local', title: 'Lokales Modell', kategorie: 'ki-modelle' }
function telegram() {
    const log: Array<{ op: string; text: string; keyboard: any[][]; messageId?: number }> = []
    let id = 100
    return {
        log,
        canSend: async () => true, ownerChatIds: () => ['111'],
        send: async (_c: string, text: string, keyboard: any[][]) => { log.push({ op: 'send', text, keyboard }); return ++id },
        edit: async (_c: string, messageId: number, text: string, keyboard: any[][]) => { log.push({ op: 'edit', text, keyboard, messageId }) },
        pin: async (_c: string, messageId: number) => { log.push({ op: 'pin', text: '', keyboard: [], messageId }) },
    }
}
const quiet = (now: number) => { const h = zonedHour(now, 'Europe/Vienna'); return h >= 22 || h < 7 }
const guided = (entries: any[], extra: Record<string, unknown> = {}) => ({
    ...opts(), verbunden: async () => entries, ruhezeit: quiet, kritisch: () => 0,
    fragen: async () => ({ frage: null, wartend: 0 }), checklist: { overview: async () => ({ gefunden: [], verbunden: [] }), telegramGekoppelt: () => true },
    isMain: () => true, ...extra,
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-example-')); t = Date.parse('2026-10-06T08:00:00.000Z') /* 10:00 Wien */ })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Beispielsätze nach neuer Verbindung', () => {
    it('come from fixed templates per type (never invented)', () => {
        expect(beispielSaetze(ha)).toEqual([...BEISPIELSAETZE.homeassistant])
        expect(beispielSaetze({ id: 'geraet:moonraker:192.0.2.20:7125', title: 'Drucker (Klipper)' })).toEqual([...BEISPIELSAETZE.drucker])
        expect(beispielSaetze({ id: 'x', title: 'Gartenpumpe' })).toEqual(['Was kannst du mit Gartenpumpe machen?', 'Was meldet Gartenpumpe gerade?', 'Ist bei Gartenpumpe alles in Ordnung?'])
    })

    it('the first look only remembers; a NEW connection gets three buttons once; a press sends the sentence as a request', async () => {
        expect(noteConnected([ki], opts())).toEqual([])
        const tg = telegram()
        await runGuidedTelegramTick(tg, guided([ki]))
        expect(tg.log.filter(item => item.op === 'send' && /Probier mal/.test(item.text))).toHaveLength(0)
        await runGuidedTelegramTick(tg, guided([ki, ha]))
        const message = tg.log.find(item => /Probier mal/.test(item.text))!
        expect(message.text).toBe('✅ Home Assistant ist verbunden. Probier mal:')
        expect(message.keyboard.map(row => row[0].text)).toEqual([...BEISPIELSAETZE.homeassistant])
        // only once
        await runGuidedTelegramTick(tg, guided([ki, ha]))
        expect(tg.log.filter(item => /Probier mal/.test(item.text))).toHaveLength(1)
        // pressing a sentence = a normal request (the pipeline decides; switching asks with a card)
        const pressed = pressGuided(message.keyboard[1][0].callback_data, { userId: '111', ownerIds: ['111'], chatId: '111' }, opts())
        expect(await runGuidedAction(pressed.aktion!, { chatId: '111', by: 'telegram:111' }, opts())).toMatchObject({ ok: true, anfrage: 'Mach das Wohnzimmerlicht aus' })
        // the app shows them too
        expect(offeneBeispiele(opts())[0]).toMatchObject({ titel: 'Home Assistant', saetze: [...BEISPIELSAETZE.homeassistant] })
    })
})

describe('höchstens ein Tipp am Tag', () => {
    it('only for what is connected, once a day, never in quiet hours', async () => {
        expect(await tippHeute({ ...opts(), typen: ['tv'], ruhezeit: () => false, abgelehnt: () => false })).toBeNull()
        const first = await tippHeute({ ...opts(), typen: ['homeassistant'], ruhezeit: () => false, abgelehnt: () => false })
        expect(first).toMatchObject({ neu: true, tipp: { id: 'ha-abends-aus' } })
        // same day: the same tip, nothing new
        t += 3 * HOUR
        expect(await tippHeute({ ...opts(), typen: ['homeassistant', 'kalender'], ruhezeit: () => false, abgelehnt: () => false })).toMatchObject({ neu: false, tipp: { id: 'ha-abends-aus' } })
        // next day 23:30 Wien: quiet hours → none
        t = Date.parse('2026-10-07T21:30:00.000Z')
        expect(await tippHeute({ ...opts(), typen: ['homeassistant', 'kalender'], ruhezeit: quiet, abgelehnt: () => false })).toBeNull()
        // next morning: another tip (the same one only again after 30 days)
        t = Date.parse('2026-10-08T08:00:00.000Z')
        expect(await tippHeute({ ...opts(), typen: ['homeassistant', 'kalender'], ruhezeit: quiet, abgelehnt: () => false })).toMatchObject({ neu: true, tipp: { id: 'kalender-morgens' } })
    })

    it('Telegram: one tip message per day with „Nein danke“; that stops the tip for good (decision memory)', async () => {
        const tg = telegram()
        noteConnected([ha], opts())
        await runGuidedTelegramTick(tg, guided([ha]))
        await runGuidedTelegramTick(tg, guided([ha]))
        const tips = tg.log.filter(item => item.text.startsWith('💡 Wusstest du?'))
        expect(tips).toHaveLength(1)
        expect(tips[0].keyboard[0].map(button => button.text)).toEqual(['Ausprobieren', 'Nein danke'])
        const no = pressGuided(tips[0].keyboard[0][1].callback_data, { userId: '111', ownerIds: ['111'], chatId: '111' }, opts())
        const result = await runGuidedAction(no.aktion!, { chatId: '111', by: 'telegram:111' }, guided([ha]))
        expect(result.ansicht).toMatchObject({ ersetzen: true })
        const decision = listDecisions({ dataDir: dir }).find(item => item.quelle.ref === 'tipp:ha-abends-aus')
        expect(decision).toMatchObject({ status: 'aktiv', bindend: true, quelle: { art: 'knopf' } })
        // 40 days later: still never again (others may come)
        t += 40 * 24 * HOUR
        const later = await tippHeute({ ...opts(), typen: ['homeassistant'], ruhezeit: () => false })
        expect(later).toBeNull()
    })

    it('unknown tips are refused; every tip has exactly one button sentence', async () => {
        expect((await tippAblehnen('gibt-es-nicht', 'x', opts())).ok).toBe(false)
        for (const tipp of TIPPS) expect(tipp.knopf.satz.length).toBeGreaterThan(5)
    })
})
