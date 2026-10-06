import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, listApprovalCards, maintainApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard } from '../core/approval-cards.js'
import { cardKeyboard } from '../core/approval-cards.js'
import { createPlanner, type Planner } from '../planner/planner.js'
import { approveDevice, loadDevices, recordCandidates, sensingDeviceFingerprint, setDeviceStatus } from './device-registry.js'
import { identifyHardware } from './hardware-recognition.js'
import { approveSmartRoute, chooseSmartRoute } from './smart-device-route.js'
import { nativeAccessRevision } from './smart-device-access.js'
import { createSchaltExecutor, findePlan, ladePlaene, registerDeviceJobs, routinenListe, sagSchalten, SCHALT_KIND, UNDO_MS, type SchaltDeps, type SchaltErgebnis, type Ziel } from './device-switch.js'
import { aktiveRoutinen, parseRoutineSatz } from './device-routines.js'
import { fehlerUrsache } from './device-errors.js'
import { fachwoerterIn } from './device-words.js'

// 2.86 Paket N: Vorschau + Rückgängig (4), Fehler als nächster Schritt (5),
// Räume (6) und Routinen (7) — nur Testdaten (192.0.2.x), kein Netz, kein Gerät.
const hue = { bridgeid: '001788fffe123456', modelid: 'BSB002', swversion: '1967054020' }
const OWNER = { userId: '111', ownerIds: ['111'] }
let dir = '', t = 0, calls: Array<{ ziel: Ziel; approver: string }> = [], antworten: SchaltErgebnis[] = [], erreichbar = false, planner: Planner
const sent: string[] = []

function lampen(functions: Array<Record<string, unknown>>) {
    const d = loadDevices(dir)[0]
    writeFileSync(join(dir, 'sensing', 'direct-inventory.json'), JSON.stringify({ version: 1, devices: [{ deviceId: d.id, fingerprint: sensingDeviceFingerprint(d), approvedAt: d.approvedAt,
        accessRevision: nativeAccessRevision(dir, d), protocol: 'hue', status: 'ok', at: new Date(t).toISOString(), functions }] }))
}
const deps = (): SchaltDeps => ({
    dataDir: dir, now: () => t,
    schalte: async (ziel, approver) => { calls.push({ ziel, approver: approver.principalId }); return antworten.shift() || { ok: true, vorbereitet: true, vorher: !ziel.on } },
    erreichbar: async () => erreichbar,
    offer: input => { const r = createApprovalCard(input, { dataDir: dir, now: () => t }); return r.ok ? { ok: true, card: r.card } : { ok: false } },
    planer: () => planner,
    neuVerbinden: async () => ({ ok: true, message: 'Karte' }),
})
const offene = () => listApprovalCards({ dataDir: dir, status: 'offen' })
const press = async (card: ApprovalCard, answer: 'ja' | 'nein' = 'ja') => answerApprovalCard(`ac:${card.buttons.find(b => b.answer === answer)!.token}`, OWNER, { dataDir: dir, now: () => t, ledger: null })

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p16-switch-'))
    t = Date.parse('2026-10-06T18:00:00Z'); calls = []; antworten = []; erreichbar = false; sent.length = 0
    const owner = { principalId: 'telegram:111', permission: 'owner' }
    const found = recordCandidates(dir, [{ type: 'networkservice', host: '192.0.2.21', port: 80, via: 'http', hardware: identifyHardware({ status: 200, body: JSON.stringify(hue) }, 'hue-config')! }], t)[0]
    chooseSmartRoute(dir, found.id, 'local', owner, t); approveDevice(dir, found.id, owner, t)
    approveSmartRoute(dir, loadDevices(dir)[0], 'local', owner.principalId)
    lampen([
        { id: 'light:1', kind: 'light', name: 'Stehlampe', raum: 'Wohnzimmer', available: true },
        { id: 'light:2', kind: 'light', name: 'Decke', raum: 'Wohnzimmer', available: true },
        { id: 'light:3', kind: 'light', name: 'Küchenlicht', available: true },
    ])
    planner = createPlanner({ dataDir: dir, now: () => t, authority: () => true, ports: { default: () => ({ name: 'test', async deliver(m) { sent.push(m.text); return { status: 'zugestellt' } } }) } })
    registerDeviceJobs(planner, deps)
    registerCardExecutor(createSchaltExecutor(deps))
})
afterEach(() => { unregisterCardExecutor(SCHALT_KIND); rmSync(dir, { recursive: true, force: true }) })

describe('Punkt 4 — Vorschau in einem Satz, dann Rückgängig', () => {
    it('zeigt vor dem Schalten EINEN Satz als Karte und schaltet erst beim Ja', async () => {
        const reply = await sagSchalten(deps(), 'Licht im Wohnzimmer aus', '111')
        expect(reply).toContain('Ich schalte jetzt 2 Lampen im Wohnzimmer aus (Stehlampe, Decke).')
        const [card] = offene()
        expect(card.titel).toBe('Ich schalte jetzt 2 Lampen im Wohnzimmer aus (Stehlampe, Decke).')
        expect(card.wirkung).toBe('physisch')
        expect(card.buttons.map(b => b.answer)).not.toContain('immer')
        expect(calls).toHaveLength(0)
        const result = await press(card)
        expect(calls.map(c => [c.ziel.functionId, c.ziel.on, c.approver])).toEqual([['light:1', false, 'telegram:111'], ['light:2', false, 'telegram:111']])
        expect(result.message).toContain('Erledigt: 2 Lampen im Wohnzimmer aus')
        expect(result.message).toContain('Rückgängig geht 5 Minuten lang.')
    })

    it('Rückgängig stellt den vorher gelesenen Zustand her, ist ein Knopf und 5 Minuten gültig', async () => {
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        await press(offene()[0])
        const undo = offene().find(c => c.titel === 'Rückgängig?')!
        expect(undo.vorschlag).toBe('Ich schalte Stehlampe im Wohnzimmer an — wieder wie vorher.')
        expect(Date.parse(undo.expiresAt) - t).toBe(UNDO_MS)
        expect(cardKeyboard(undo).flat().map(b => b.text)).toEqual(['↩️ Rückgängig'])
        calls = []
        const result = await press(undo)
        expect(calls.map(c => [c.ziel.functionId, c.ziel.on])).toEqual([['light:1', true]])
        expect(result.message).toContain('Wieder wie vorher: Stehlampe im Wohnzimmer an.')
        expect(offene()).toHaveLength(0)
    })

    it('ohne lesbaren Zustand gibt es ehrlich keinen Rückgängig-Knopf', async () => {
        antworten = [{ ok: true, vorbereitet: true }]
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        const result = await press(offene()[0])
        expect(result.message).toContain('Rückgängig gibt es für Stehlampe im Wohnzimmer nicht, weil es seinen Zustand nicht meldet.')
        expect(offene()).toHaveLength(0)
    })

    it('Rückgängig nach 5 Minuten und Nein schalten nichts', async () => {
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        await press(offene()[0])
        const undo = offene()[0]
        calls = []; t += UNDO_MS + 1
        expect((await press(undo)).code).toBe('abgelaufen')
        await sagSchalten(deps(), 'mach die Decke an', '111')
        await press(offene().find(c => c.titel.includes('Decke'))!, 'nein')
        expect(calls).toHaveLength(0)
    })
})

describe('Punkt 5 — Fehler als nächster Schritt', () => {
    it('Gerät aus → ein Satz + Angebot; Ja wartet über den Planer und versucht GENAU einmal', async () => {
        antworten = [{ ok: false, vorbereitet: true, fehler: Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }) }]
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        const result = await press(offene()[0])
        expect(result.message).toContain('Hat nicht geklappt, Stehlampe im Wohnzimmer ist aus oder gerade nicht erreichbar. Nochmal versuchen, wenn es wieder an ist?')
        const angebot = offene()[0]
        expect(cardKeyboard(angebot).flat().map(b => b.text)).toEqual(['Ja, wenn es an ist'])
        expect((await press(angebot)).message).toContain('Sobald Stehlampe im Wohnzimmer wieder erreichbar ist, versuche ich es genau einmal')
        const job = planner.listJobs({ kind: 'geraet-nochmal' })[0]
        expect(job.schedule).toEqual({ type: 'intervall', minutes: 1 })
        calls = []
        await planner.tick(); t += 60_000; await planner.tick()
        expect(calls).toHaveLength(0)
        erreichbar = true; t += 60_000; await planner.tick()
        expect(calls.map(c => [c.ziel.functionId, c.ziel.on])).toEqual([['light:1', false]])
        expect(sent.at(-1)).toContain('Stehlampe im Wohnzimmer ist wieder da. Erledigt: Stehlampe im Wohnzimmer aus.')
        t += 60_000; await planner.tick(); t += 60_000; await planner.tick()
        expect(calls).toHaveLength(1)
        expect(planner.getJob(job.id)!.status).toBe('erledigt')
    })

    it('wartet höchstens 12 Stunden und schaltet dann nichts', async () => {
        antworten = [{ ok: false, vorbereitet: true, fehler: new Error('Hue light not currently reachable') }]
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        await press(offene()[0]); await press(offene()[0])
        calls = []; t += 12 * 60 * 60_000 + 60_000; erreichbar = true
        await planner.tick()
        expect(calls).toHaveLength(0)
        expect(sent.at(-1)).toBe('Ich habe 12 Stunden gewartet, Stehlampe im Wohnzimmer war nicht erreichbar. Nichts geschaltet.')
    })

    it('Zeitüberschreitung, abgelaufene Anmeldung und Unbekanntes werden je ein Satz', async () => {
        antworten = [{ ok: false, vorbereitet: true, fehler: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }]
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        expect((await press(offene()[0])).message).toContain('hat zu lange nicht geantwortet. Nochmal versuchen, sobald es antwortet?')
        await press(offene()[0], 'nein')
        antworten = [{ ok: false, vorbereitet: true, fehler: new Error('HTTP 401 unauthorized') }]
        await sagSchalten(deps(), 'mach die Decke aus', '111')
        expect((await press(offene()[0])).message).toContain('Decke im Wohnzimmer lässt mich nicht mehr hinein. Einmal neu verbinden?')
        const neu = offene()[0]
        expect(cardKeyboard(neu).flat().map(b => b.text)).toEqual(['Neu verbinden'])
        expect((await press(neu)).message).toContain('Die Karte zum neu Verbinden ist unterwegs.')
        antworten = [{ ok: false, vorbereitet: true, fehler: new Error('something odd') }]
        await sagSchalten(deps(), 'mach die Decke aus', '111')
        expect((await press(offene()[0])).message).toContain('Den Grund kenne ich nicht; ich versuche es nicht von selbst nochmal.')
        expect(offene()).toHaveLength(0)
    })

    it('erkennt die Ursache auch verschachtelt und aus dem Bestand', () => {
        expect(fehlerUrsache(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('aus')
        expect(fehlerUrsache({ name: 'AbortError', message: 'This operation was aborted' })).toBe('zeit')
        expect(fehlerUrsache(new Error('Missing private cloud access'))).toBe('anmeldung')
        expect(fehlerUrsache(new Error('Unsupported device control'))).toBe('unbekannt')
    })
})

describe('Punkt 6 — Räume statt Geräte-IDs', () => {
    it('„Licht aus“ bei Lampen in mehreren Räumen → EINE Rückfrage mit Knöpfen, dann die Vorschau nur für den Raum', async () => {
        const reply = await sagSchalten(deps(), 'Licht aus', '111')
        expect(reply).toContain('Welches Licht meinst du?')
        const frage = offene()
        expect(frage.map(c => c.knopf)).toEqual(['Wohnzimmer', 'Küche', 'Überall'])
        expect(new Set(frage.map(c => c.gruppe)).size).toBe(1)
        expect(frage.every(c => c.buendel === 'raumwahl')).toBe(true)
        expect(calls).toHaveLength(0)
        const result = await press(frage[0])
        expect(result.message).toContain('Gut. Ich schalte jetzt 2 Lampen im Wohnzimmer aus')
        maintainApprovalCards({ dataDir: dir, now: () => t })
        const rest = offene()
        expect(rest).toHaveLength(1)
        expect(rest[0].titel).toBe('Ich schalte jetzt 2 Lampen im Wohnzimmer aus (Stehlampe, Decke).')
        expect(calls).toHaveLength(0)
    })

    it('ein unbekannter Raum wird ehrlich gesagt, nichts geschaltet; ein fremder Satz geht ins Gespräch', async () => {
        expect(await sagSchalten(deps(), 'Licht im Keller aus', '111')).toBe('Einen Raum „keller“ kenne ich noch nicht. Ich kenne: Wohnzimmer, Küche.')
        expect(await sagSchalten(deps(), 'mach den Fernseher aus', '111')).toBe('')
        expect(await sagSchalten(deps(), 'Wie spät ist es', '111')).toBe('')
        expect(offene()).toHaveLength(0)
    })

    it('ein anderes Konto schaltet nie; ein abgeschaltetes Gerät wird nicht angeboten', async () => {
        await sagSchalten(deps(), 'mach die Stehlampe aus', '999')
        const result = await answerApprovalCard(`ac:${offene()[0].buttons.find(b => b.answer === 'ja')!.token}`, { userId: '222', ownerIds: ['222'] }, { dataDir: dir, now: () => t, ledger: null })
        expect(result.message).toContain('Hat nicht geklappt bei Stehlampe im Wohnzimmer.')
        expect(calls).toHaveLength(0)
        setDeviceStatus(dir, loadDevices(dir)[0].id, 'aus', { principalId: 'telegram:111', permission: 'owner' })
        expect(await sagSchalten(deps(), 'mach die Decke aus', '111')).toBe('')
        expect(offene()).toHaveLength(0)
        expect(calls).toHaveLength(0)
    })
})

describe('Punkt 7 — Routinen in Alltagssprache', () => {
    it('versteht feste Muster deterministisch', () => {
        expect(parseRoutineSatz('Jeden Abend um 23 Uhr alles aus')).toEqual({ zeit: '23:00', satz: { on: false, was: 'alles' } })
        expect(parseRoutineSatz('jeden Abend um 11 Licht im Wohnzimmer aus')).toEqual({ zeit: '23:00', satz: { on: false, was: 'licht', raum: 'wohnzimmer' } })
        expect(parseRoutineSatz('Jeden Morgen um 6:30 Uhr Küchenlicht an')).toEqual({ zeit: '06:30', satz: { on: true, was: 'licht', raum: 'kuechen' } })
        expect(parseRoutineSatz('täglich um 22 Uhr Stehlampe aus')).toEqual({ zeit: '22:00', satz: { on: false, was: 'name', name: 'stehlampe' } })
        expect(parseRoutineSatz('Jeden Abend um 25 Uhr alles aus')).toBeNull()
        expect(parseRoutineSatz('Was machst du jeden Abend um 23 Uhr?')).toBeNull()
    })

    it('Vorschau → ein Ja → Planer-Job; jede Ausführung schaltet nur, was im Ja enthalten war', async () => {
        const reply = await sagSchalten(deps(), 'Jeden Abend um 23 Uhr alles aus', '111')
        expect(reply).toContain('Jeden Tag um 23:00 schalte ich 3 Lampen aus (Stehlampe im Wohnzimmer, Decke im Wohnzimmer, Küchenlicht) — nur genau das.')
        const card = offene()[0]
        expect(card.buttons.map(b => b.answer)).not.toContain('immer')
        expect((await press(card)).message).toContain('Gespeichert:')
        const job = planner.listJobs({ kind: 'geraete-routine' })[0]
        expect(job.schedule).toMatchObject({ type: 'taeglich', time: '23:00' })
        expect(job.mainOnly).toBe(true)
        expect(calls).toHaveLength(0)
        // später kommt eine Lampe dazu: sie gehört NICHT zur Routine
        lampen([{ id: 'light:1', kind: 'light', name: 'Stehlampe', raum: 'Wohnzimmer' }, { id: 'light:2', kind: 'light', name: 'Decke', raum: 'Wohnzimmer' },
            { id: 'light:3', kind: 'light', name: 'Küchenlicht' }, { id: 'light:4', kind: 'light', name: 'Neue Lampe', raum: 'Wohnzimmer' }])
        t = Date.parse(job.nextRunAt!) + 1000
        await planner.tick()
        expect(calls.map(c => c.ziel.functionId).sort()).toEqual(['light:1', 'light:2', 'light:3'])
        expect(sent).toHaveLength(0)
        // die Vertrauensleiter bleibt unberührt (physisch, kein „Immer“)
        expect(existsSync(join(dir, 'action-policy', 'trust.json'))).toBe(false)
    })

    it('ein Gerät mit geänderter Freigabe wird ausgelassen und gemeldet', async () => {
        await sagSchalten(deps(), 'jeden Abend um 23 Uhr Stehlampe aus', '111')
        await press(offene()[0])
        const id = loadDevices(dir)[0].id
        setDeviceStatus(dir, id, 'aus', { principalId: 'telegram:111', permission: 'owner' })
        approveDevice(dir, id, { principalId: 'telegram:111', permission: 'owner' }, t + 5000)
        const job = planner.listJobs({ kind: 'geraete-routine' })[0]
        t = Date.parse(job.nextRunAt!) + 1000
        await planner.tick()
        expect(calls).toHaveLength(0)
        expect(sent.at(-1)).toContain('Stehlampe im Wohnzimmer habe ich ausgelassen, weil sich die Freigabe geändert hat.')
    })

    it('Liste mit Knopf „Beenden“; Beenden stoppt den Planer-Job', async () => {
        await sagSchalten(deps(), 'jeden Abend um 23 Uhr Stehlampe aus', '111')
        await press(offene()[0])
        const liste = await routinenListe(deps(), '111')
        expect(liste).toContain('1. Jeden Tag um 23:00 schalte ich Stehlampe im Wohnzimmer aus')
        const ende = offene()[0]
        expect(ende).toMatchObject({ buendel: 'routinen', knopf: 'Beenden' })
        expect((await press(ende)).message).toContain('Beendet:')
        expect(aktiveRoutinen(dir)).toHaveLength(0)
        expect(planner.listJobs({ kind: 'geraete-routine' })[0].status).toBe('erledigt')
    })
})

describe('Alltagssprache in allen neuen Owner-Texten', () => {
    it('keine Fachwörter in Karten und Antworten dieser Wege', async () => {
        antworten = [{ ok: false, vorbereitet: true, fehler: new Error('HTTP 401') }]
        const texte = [await sagSchalten(deps(), 'Licht aus', '111')]
        await press(offene()[0])
        texte.push(...offene().map(c => `${c.titel} ${c.vorschlag} ${c.beleg} ${c.kurz || ''}`))
        for (const p of ladePlaene(dir)) texte.push(p.satz, p.ergebnis || '')
        texte.push(await sagSchalten(deps(), 'Jeden Abend um 23 Uhr alles aus', '111'), await routinenListe(deps(), '111'))
        for (const text of texte) { expect(fachwoerterIn(text)).toEqual([]); expect(text).not.toMatch(/192\.0\.2|dev-[a-f0-9]|light:\d|sp-[a-f0-9]/) }
        expect(findePlan(dir, 'sp-000000000000')).toBeUndefined()
    })
})

// 2.86 Zusammenstecken (N + M): die Fragewarteschlange gilt auch für Geräte-Karten.
describe('Fragewarteschlange: was ist eine direkte Antwort?', () => {
    it('die Vorschau eines eben gewünschten Schaltens (und einer Routine) ist eine direkte Antwort; Fehler-Angebote nicht', async () => {
        await sagSchalten(deps(), 'mach die Stehlampe aus', '111')
        const [vorschau] = offene()
        expect(vorschau.direktAt).toBe(new Date(t).toISOString())
        await sagSchalten(deps(), 'jeden Abend um 23 Uhr Stehlampe aus', '111')
        expect(offene().find(c => c.titel.startsWith('Jeden Tag'))!.direktAt).toBeTruthy()
        antworten = [{ ok: false, vorbereitet: true, fehler: new Error('Hue light not currently reachable') }]
        await press(vorschau)
        const angebot = offene().find(c => c.titel.startsWith('Hat nicht geklappt'))!
        expect(angebot).toBeTruthy()
        expect(angebot.direktAt).toBeUndefined()
    })
})
