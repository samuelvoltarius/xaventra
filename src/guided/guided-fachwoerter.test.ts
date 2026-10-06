import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACHWOERTER, findeFachwoerter } from './fachwoerter.js'
import { BEISPIELSAETZE, beispielKopf, beispielSaetze } from './example-prompts.js'
import { TIPPS } from './daily-tip.js'
import { findeLoesung, HILFE_DIAGNOSE, HILFE_UNBEKANNT_ALLEIN, HILFE_UNBEKANNT_GEFRAGT, HILFE_UNBEKANNT_SCHON } from './stuck-helper.js'
import { buildChecklist, factsFromOverview, skipChecklistItem } from './setup-checklist.js'
import { checklistView, guidedMenuRow, hilfeView, pinnedText, tippView } from './telegram-guided.js'
import { buildCockpit, systemKopf } from './ampel.js'
import { APP_SATZ } from './guided-runtime.js'

// 2.86 Paket M Grundsatz: keine Fachwörter in Owner-Texten. Eine Liste (fachwoerter.ts),
// ein Test gegen ALLE Owner-Texte von Paket M (Telegram, App, Bericht).

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-words-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ownerTexts(): string[] {
    const texts: string[] = []
    for (const saetze of Object.values(BEISPIELSAETZE)) texts.push(...saetze)
    texts.push(beispielKopf('Home Assistant'), ...beispielSaetze({ id: 'x', title: 'Gartenpumpe' }))
    for (const tipp of TIPPS) texts.push(tipp.text, tipp.knopf.label, tipp.knopf.satz)
    for (const entry of Object.values(HILFE_DIAGNOSE)) texts.push(entry!.satz, entry!.knopf?.label || '')
    texts.push(HILFE_UNBEKANNT_ALLEIN, HILFE_UNBEKANNT_GEFRAGT, HILFE_UNBEKANNT_SCHON, ...Object.values(APP_SATZ))
    for (const status of ['abgelaufen', 'fehler', 'wartet-auf-zugang', 'wartet-auf-anmeldung']) {
        const answer = findeLoesung({ verbindungen: [{ title: 'Google Kalender', status }] })!
        texts.push(answer.satz, answer.knopf!.label)
    }
    const frage = findeLoesung({ frage: { id: 'k000000000001', titel: 'Hue Bridge koppeln?' } })!
    texts.push(frage.satz, frage.knopf!.label)
    const overview = {
        gefunden: [
            { id: 'geraet:hue:192.0.2.11:80', title: 'Hue Bridge', kategorie: 'zuhause', wirkung: '', fund: '', verbunden: false, geraet: { id: 'dev-00000000bb', verbinden: 'hue', dienste: 1 } },
            { id: 'konto:gmail:x', title: 'Gmail', kategorie: 'kommunikation', wirkung: '', fund: '', verbunden: false, connectorId: 'gmail' },
        ],
        verbunden: [{ id: 'c', connectorId: 'google-calendar', title: 'Google Kalender', status: 'verbunden' }],
    } as any
    for (const paired of [true, false]) {
        for (const ki of [true, false]) {
            const list = buildChecklist({ ...factsFromOverview(overview, { telegramGekoppelt: paired }), kiBereit: ki })
            texts.push(list.kopf, ...list.punkte.flatMap(item => [item.titel, item.satz, item.knopf?.label || '']))
            const view = checklistView('111', list, { dataDir: dir })
            texts.push(view.text, ...view.keyboard.flat().map(button => button.text))
            const next = findeLoesung({ einrichtung: list })
            if (next) texts.push(next.satz, next.knopf?.label || '')
        }
    }
    texts.push(skipChecklistItem('ki', { dataDir: dir }).message)
    texts.push(...guidedMenuRow('111', { dataDir: dir }).flat().map(button => button.text))
    texts.push(hilfeView('111', { satz: HILFE_UNBEKANNT_GEFRAGT, quelle: 'claude' }, { dataDir: dir }).text)
    for (const tipp of TIPPS) texts.push(...tippView('111', tipp, { dataDir: dir }).keyboard.flat().map(button => button.text))
    for (const facts of [
        { kritisch: 0, einrichtung: { fertig: false, kopf: '2 von 5 erledigt' }, frage: { titel: 'Hue Bridge koppeln?' }, wartend: 2 },
        { kritisch: 2, einrichtung: { fertig: true, kopf: '5 von 5 erledigt' }, frage: null, wartend: 0 },
        { kritisch: 1, einrichtung: null, frage: null, wartend: 0 },
    ]) texts.push(pinnedText(facts, Date.parse('2026-10-06T10:00:00.000Z')).text)
    for (const input of [
        { kritisch: 1, verbindungFehler: 0, probleme: 0, frage: null, wartend: 0, getan: [], gelernt: [] },
        { kritisch: 0, verbindungFehler: 2, probleme: 0, frage: { id: 'k1', titel: 'Hue Bridge koppeln?' }, wartend: 1, getan: ['A'], gelernt: ['B'] },
        { kritisch: 0, verbindungFehler: 0, probleme: 1, frage: { id: 'k1', titel: 'x' }, wartend: 3, getan: ['A', 'B'], gelernt: ['B', 'C'] },
        { kritisch: 0, verbindungFehler: 0, probleme: 0, frage: null, wartend: 0, getan: [], gelernt: [] },
    ]) for (const tile of buildCockpit(input)) texts.push(tile.titel, tile.satz, ...tile.zeilen)
    texts.push(systemKopf({ kind: 'gedanke', urgency: 'dringend' }), systemKopf({ kind: 'gedanke' }), systemKopf({ kind: 'job' }))
    // App: visible text nodes of the cockpit renderer
    const renderer = readFileSync(join(process.env.NOVA_PROJECT_ROOT || process.cwd(), 'desktop', 'renderer', 'cockpit.js'), 'utf8')
    texts.push(...[...renderer.matchAll(/>([^<>$`{}]{3,})</g)].map(match => match[1]))
    return texts.filter(text => text && text.trim())
}

describe('Fachwörter in Owner-Texten', () => {
    it('the list catches the words from the principle', () => {
        expect(findeFachwoerter('Mesh-Lease über die Fabric, Matter-Pairing mit Local-Key per MCP am Endpoint, Token, Doctor-Fall, Layer L05')).toEqual(expect.arrayContaining(
            ['Mesh', 'Lease', 'Fabric', 'Matter-Pairing', 'Local-Key', 'MCP', 'Endpoint', 'Token', 'Doctor-Fall', 'Layer', 'Layer-Nummer']))
        expect(findeFachwoerter('Mach das Wohnzimmerlicht aus')).toEqual([])
        expect(FACHWOERTER.length).toBeGreaterThanOrEqual(10)
    })

    it('no new owner text of Paket M contains a technical word', () => {
        const texts = ownerTexts()
        expect(texts.length).toBeGreaterThan(150)
        const hits = texts.map(text => ({ text, woerter: findeFachwoerter(text) })).filter(item => item.woerter.length)
        expect(hits).toEqual([])
    })
})
