import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCockpit, cockpitZeilen, systemKopf } from './ampel.js'
import { updatePinnedStatus } from './telegram-guided.js'

// 2.86 Paket M Übersichtlichkeit: Heute als Cockpit mit 4 Ampel-Kacheln, angeheftete
// Statusnachricht (bearbeitet statt neu gesendet), Ampel + ein Satz als Kopf.

let dir: string
let t: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-cockpit-')); t = Date.parse('2026-10-06T10:00:00.000Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function telegram() {
    const log: Array<{ op: string; text: string; keyboard: any[][]; messageId?: number }> = []
    let id = 500
    return {
        log,
        canSend: async () => true, ownerChatIds: () => ['111'],
        send: async (_c: string, text: string, keyboard: any[][]) => { log.push({ op: 'send', text, keyboard }); return ++id },
        edit: async (_c: string, messageId: number, text: string, keyboard: any[][]) => { log.push({ op: 'edit', text, keyboard, messageId }) },
        pin: async (_c: string, messageId: number) => { log.push({ op: 'pin', text: '', keyboard: [], messageId }) },
    }
}

describe('Cockpit Heute', () => {
    it('four tiles, each a traffic light and one sentence', () => {
        const tiles = buildCockpit({ kritisch: 0, verbindungFehler: 0, probleme: 0, frage: { id: 'k000000000001', titel: 'Hue Bridge koppeln?' }, wartend: 2, getan: ['ffmpeg installiert', 'Platte aufgeräumt'], gelernt: [] })
        expect(tiles.map(tile => [tile.titel, tile.ampel])).toEqual([['Läuft alles?', 'gruen'], ['Braucht dich', 'gelb'], ['Was sie heute getan hat', 'gruen'], ['Was sie gelernt hat', 'gruen']])
        expect(tiles[1]).toMatchObject({ satz: '„Hue Bridge koppeln?“', zeilen: ['Danach warten noch 2 Fragen – sie kommen einzeln.'], karteId: 'k000000000001' })
        expect(tiles[2].satz).toBe('2 Sachen erledigt.')
        expect(buildCockpit({ kritisch: 1, verbindungFehler: 0, probleme: 0, frage: null, wartend: 0, getan: [], gelernt: [] })[0]).toMatchObject({ ampel: 'rot', satz: '1 Problem braucht dich.' })
        expect(buildCockpit({ kritisch: 0, verbindungFehler: 2, probleme: 0, frage: null, wartend: 0, getan: [], gelernt: [] })[0]).toMatchObject({ ampel: 'gelb' })
    })

    it('getan/gelernt come from the report sections', () => {
        expect(cockpitZeilen([{ titel: 'Erledigt', zeilen: ['A'] }, { titel: 'Installiert', zeilen: ['B'] }, { titel: 'Neu gemerkt', zeilen: ['C'] }, { titel: 'Ideen', zeilen: ['D'] }])).toEqual({ getan: ['A', 'B'], gelernt: ['C'] })
    })

    it('system messages start with a traffic light and one sentence', () => {
        expect(systemKopf({ kind: 'gedanke', urgency: 'dringend' })).toBe('🔴 Das braucht dich jetzt.')
        expect(systemKopf({ kind: 'gedanke', urgency: 'normal' })).toBe('🟡 Zur Info – nichts eilt.')
        expect(systemKopf({ kind: 'job', urgency: 'normal' })).toBe('🟢 Erledigt.')
    })
})

describe('angeheftete Statusnachricht', () => {
    it('is sent and pinned once, then edited only when something changed', async () => {
        const tg = telegram()
        const facts = { kritisch: 0, einrichtung: { fertig: false, kopf: '2 von 5 erledigt' }, frage: { titel: 'Hue Bridge koppeln?' }, wartend: 1 }
        expect(await updatePinnedStatus(tg, facts, { dataDir: dir, now: () => t })).toBe(1)
        expect(tg.log.map(item => item.op)).toEqual(['send', 'pin'])
        const text = tg.log[0].text
        expect(text.split('\n')[0]).toBe('🟡 Alles läuft.')
        expect(text).toContain('🧭 Einrichtung: 2 von 5 erledigt')
        expect(text).toContain('Braucht dich: „Hue Bridge koppeln?“ (danach 1 weitere)')
        expect(tg.log[0].keyboard.flat().map(button => button.text)).toEqual(['🧭 Weiter einrichten', '🆘 Ich komm nicht weiter'])
        // nothing changed (only the clock) → no edit
        t += 5 * 60_000
        expect(await updatePinnedStatus(tg, facts, { dataDir: dir, now: () => t })).toBe(0)
        // setup finished, question answered → the SAME message is edited
        expect(await updatePinnedStatus(tg, { kritisch: 0, einrichtung: { fertig: true, kopf: '5 von 5 erledigt' }, frage: null, wartend: 0 }, { dataDir: dir, now: () => t })).toBe(1)
        const edit = tg.log.at(-1)!
        expect(edit).toMatchObject({ op: 'edit', messageId: 501 })
        expect(edit.text).not.toContain('Einrichtung')
        expect(edit.text.split('\n')[0]).toBe('🟢 Alles läuft.')
        expect(edit.keyboard.flat().map(button => button.text)).toEqual(['🆘 Ich komm nicht weiter'])
        expect(tg.log.filter(item => item.op === 'send')).toHaveLength(1)
    })

    it('a deleted pinned message is sent and pinned again', async () => {
        const tg = telegram()
        const facts = { kritisch: 1, einrichtung: null, frage: null, wartend: 0 }
        await updatePinnedStatus(tg, facts, { dataDir: dir, now: () => t })
        const broken = { ...tg, edit: async () => { throw new Error('message to edit not found') } }
        await updatePinnedStatus(broken, { ...facts, kritisch: 2 }, { dataDir: dir, now: () => t })
        expect(tg.log.filter(item => item.op === 'pin')).toHaveLength(2)
        expect(tg.log.at(-2)!.text.split('\n')[0]).toBe('🔴 2 Probleme brauchen dich.')
    })
})
