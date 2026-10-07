import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAction, evaluateActionWithTrust, setDecisionConstraintProvider, setOwnerAllowanceProvider } from '../core/action-policy.js'
import { activeAllowances, activeConstraints, lichtOhneFrage, listDecisions, observeOwnerMessage, type DecisionOptions } from '../core/decisions.js'
import { aendereRegel, entferneRegel, listeRegeln, neueRegel, regelKern, regelnText } from './regeln.js'

const T0 = Date.parse('2026-10-07T09:00:00.000Z')
let dir: string
let opts: DecisionOptions
const by = { principalId: 'owner-1' }
const gespraech = (text: string) => observeOwnerMessage({ text, permission: 'owner', principalId: 'owner-1', channel: 'telegram' }, opts)
const wire = () => {
    setDecisionConstraintProvider(() => activeConstraints(opts))
    setOwnerAllowanceProvider(() => activeAllowances(opts).filter(item => !item.nur).flatMap(item => item.arten))
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'regeln-'))
    opts = { dataDir: dir, now: () => T0, isMain: () => true }
})
afterEach(() => {
    setDecisionConstraintProvider(null)
    setOwnerAllowanceProvider(null)
    rmSync(dir, { recursive: true, force: true })
})

describe('Regeln entstehen im Gespräch, ohne Befehl', () => {
    it('„Lichter darfst du ohne Frage schalten“ → erlauben (nur Licht), wirksam', () => {
        expect(gespraech('Lichter darfst du ohne Frage schalten.').created).toHaveLength(1)
        const [regel] = listeRegeln(opts)
        expect(regel).toMatchObject({ wirkung: 'erlauben', bereich: 'Lichter schalten', wirksam: true, fest: false, quelle: 'gespräch' })
        expect(lichtOhneFrage(opts)).toBe(true)
        // Die Policy selbst bleibt: schalten (physisch) fragt weiter; nur der Lichtweg nutzt die Regel.
        wire()
        expect(evaluateActionWithTrust({ kind: 'schalten', origin: 'code' }, { dataDir: dir })).toMatchObject({ level: 'L2', decision: 'ask' })
    })

    it('„bei Mails immer fragen“ → fragen, Policy fragt', () => {
        gespraech('Bei Mails immer fragen.')
        expect(listeRegeln(opts)[0]).toMatchObject({ wirkung: 'fragen', bereich: 'E-Mails senden', wirksam: true })
        wire()
        expect(evaluateAction({ kind: 'mail-senden', origin: 'code' })).toMatchObject({ decision: 'ask' })
    })

    it('„nie etwas löschen“ → blockieren', () => {
        gespraech('Nie etwas löschen.')
        const [regel] = listeRegeln(opts)
        expect(regel).toMatchObject({ wirkung: 'blockieren', bereich: 'Löschen', wirksam: true })
        expect(regel.hinweis).toMatch(/ohnehin/)
        wire()
        expect(evaluateAction({ kind: 'daten-loeschen', origin: 'owner' }).level).toBe('L3')
    })

    it('Gegenprobe: eine normale Erzählung ist keine Regel', () => {
        gespraech('Das Konzert war ohne Frage gut.')
        gespraech('Kannst du mir das Licht im Bad zeigen?')
        expect(listeRegeln(opts)).toHaveLength(0)
        expect(lichtOhneFrage(opts)).toBe(false)
    })
})

describe('Feste Sicherheitsregeln lassen sich nicht lockern – freundlich gesagt', () => {
    it.each([
        ['Bezahlen darfst du ohne Frage.', /Geld/],
        ['Passwörter darfst du ohne zu fragen ändern.', /Passwörter/],
        ['Backups darfst du ohne Frage löschen.', /Löschen/],
        ['Mails darfst du ohne zu fragen senden.', /Nachrichten nach außen/],
        ['Die Heizung darfst du ohne Frage schalten.', /Geräte/],
    ])('%s → gespeichert, aber nicht wirksam', (satz, grund) => {
        const antwort = neueRegel(satz, by, opts)
        expect(antwort.ok).toBe(true)
        expect(antwort.regel).toMatchObject({ wirkung: 'erlauben', wirksam: false, fest: true })
        expect(antwort.message).toMatch(grund)
        expect(antwort.message).toMatch(/feste Sicherheitsregel/)
        expect(activeAllowances(opts)).toHaveLength(0)
        expect(lichtOhneFrage(opts)).toBe(false)
    })

    it('Licht plus Geld in einem Satz bleibt fest', () => {
        expect(neueRegel('Lichter und Bestellungen darfst du ohne Frage erledigen.', by, opts).regel).toMatchObject({ wirksam: false, fest: true })
        expect(lichtOhneFrage(opts)).toBe(false)
    })
})

describe('erlauben wirkt über die eine Policy (nur interne Arten)', () => {
    it('„Dienste darfst du ohne Frage neu starten“ → L1 über evaluateActionWithTrust; evaluateAction bleibt L2', () => {
        const antwort = neueRegel('Dienste darfst du ohne Frage neu starten', by, opts)
        expect(antwort.regel).toMatchObject({ wirkung: 'erlauben', wirksam: true, bereich: 'Dienste neu starten' })
        wire()
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'code' }, { dataDir: dir })).toMatchObject({ level: 'L1', decision: 'auto', trusted: true })
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'code' }, { dataDir: dir }).reason).toMatch(/Owner-Regel/)
        expect(evaluateAction({ kind: 'dienst-neustart', origin: 'code' }).level).toBe('L2')
        // Fremder Knoten bleibt fragen.
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'code', node: 'worker-a' }, { dataDir: dir, localNodeId: 'main-a' }).decision).toBe('ask')
    })

    it('ein manipulierter Speicher mit „erlauben“ für eine feste Art greift nie', () => {
        setOwnerAllowanceProvider(() => ['mail-senden', 'release-ausrollen', 'schalten'])
        for (const kind of ['mail-senden', 'release-ausrollen', 'schalten']) {
            expect(evaluateActionWithTrust({ kind, origin: 'code' }, { dataDir: dir }).decision).toBe('ask')
        }
    })
})

describe('Liste ändern und entfernen', () => {
    it('Wirkung ändern ersetzt die alte Regel; die Policy folgt', () => {
        const erlaubt = neueRegel('Dienste darfst du ohne Frage neu starten', by, opts).regel!
        wire()
        const geaendert = aendereRegel(erlaubt.id, 'blockieren', by, opts)
        expect(geaendert.ok).toBe(true)
        expect(geaendert.regel).toMatchObject({ wirkung: 'blockieren', wirksam: true })
        const regeln = listeRegeln(opts)
        expect(regeln).toHaveLength(1)
        expect(regeln[0].id).toBe(geaendert.regel!.id)
        expect(evaluateActionWithTrust({ kind: 'dienst-neustart', origin: 'code' }, { dataDir: dir })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(listDecisions(opts).find(item => item.id === erlaubt.id)?.status).not.toBe('aktiv')
    })

    it('entfernen → wieder das Übliche', () => {
        const regel = neueRegel('Bei Mails immer fragen', by, opts).regel!
        expect(entferneRegel(regel.id, by, opts)).toMatchObject({ ok: true })
        expect(listeRegeln(opts)).toHaveLength(0)
        expect(entferneRegel(regel.id, by, opts).ok).toBe(false)
        expect(entferneRegel('../x', by, opts).ok).toBe(false)
    })

    it('widersprechende neue Regel aus der App ersetzt die alte ausdrücklich', () => {
        neueRegel('Lichter darfst du ohne Frage schalten', by, opts)
        expect(lichtOhneFrage(opts)).toBe(true)
        const antwort = neueRegel('Bei Lichtern immer fragen', by, opts)
        expect(antwort.regel).toMatchObject({ wirkung: 'fragen' })
        expect(lichtOhneFrage(opts)).toBe(false)
        expect(listeRegeln(opts).filter(item => item.status === 'gilt')).toHaveLength(1)
    })

    it('Fragen und Leeres sind keine Regel; nur der Main speichert', () => {
        expect(neueRegel('Darfst du Lichter schalten?', by, opts).ok).toBe(false)
        expect(neueRegel('   ', by, opts).ok).toBe(false)
        expect(neueRegel('Bei Mails immer fragen', by, { ...opts, isMain: () => false }).message).toMatch(/Hauptrechner/)
    })

    it('Kern ohne Steuerwörter', () => {
        expect(regelKern('Lichter darfst du ohne Frage schalten')).toBe('Lichter schalten')
        expect(regelKern('Bei Mails immer fragen')).toBe('Mails')
    })

    it('Telegram-Kurzliste: eine Seite, feste Grenze erklärt', () => {
        neueRegel('Lichter darfst du ohne Frage schalten', by, opts)
        neueRegel('Bezahlen darfst du ohne Frage', by, opts)
        const text = regelnText(opts)
        expect(text).toMatch(/Lichter schalten/)
        expect(text).toMatch(/feste Sicherheitsregel/)
        expect(text.length).toBeLessThan(3500)
    })
})
