import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAction, setDecisionConstraintProvider } from './action-policy.js'
import {
    activeConstraints, buildDecisionContext, decisionsForBriefing, handleEntscheidungenCommand, listDecisions, observeOwnerMessage,
    parseOwnerDirectives, recordCardDecision, recordDelegationDecision, recordMissionDecision, relevantDecisions, revokeDecision,
    type DecisionOptions,
} from './decisions.js'

const T0 = Date.parse('2026-09-30T10:00:00.000Z')
let dir: string
let clock: number
let opts: DecisionOptions
const owner = (text: string, extra: Record<string, unknown> = {}) =>
    observeOwnerMessage({ text, permission: 'owner', principalId: 'alfred', channel: 'telegram', ...extra }, opts)

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decisions-'))
    clock = T0
    opts = { dataDir: dir, now: () => clock, isMain: () => true }
})
afterEach(() => {
    setDecisionConstraintProvider(null)
    rmSync(dir, { recursive: true, force: true })
})

describe('Owner-Anweisungen werden selbst gemerkt', () => {
    it('„ab jetzt …, weil …“ vom Owner → Eintrag mit Quelle, Zeit und Grund, gilt bis widerrufen', () => {
        const result = owner('Ab jetzt Telegram nur am Main, weil es nur einen Konsumenten geben darf.')
        expect(result.created).toHaveLength(1)
        const [decision] = listDecisions(opts)
        expect(decision.text).toBe('Telegram nur am Main')
        expect(decision.warum).toBe('es nur einen Konsumenten geben darf')
        expect(decision.quelle).toMatchObject({ art: 'owner-nachricht', von: 'owner:alfred', kanal: 'telegram' })
        expect(decision.at).toBe(new Date(T0).toISOString())
        expect(decision.bindend).toBe(true)
        expect(decision.gueltigBis).toBeUndefined()
        expect(decision.status).toBe('aktiv')
    })

    it('Gegenprobe: Nicht-Owner, Gruppe, Systemnachricht, Befehl und Frage erzeugen nichts', () => {
        expect(observeOwnerMessage({ text: 'Ab jetzt immer Druck ohne Knopf', permission: 'user', principalId: 'gast' }, opts).created).toHaveLength(0)
        expect(observeOwnerMessage({ text: 'Ab jetzt immer Druck ohne Knopf', permission: 'admin', principalId: 'kollege' }, opts).created).toHaveLength(0)
        expect(owner('Ab jetzt immer Telegram am Pi5', { isGroup: true }).created).toHaveLength(0)
        expect(owner('Ab jetzt immer Telegram am Pi5', { systemAuthored: true }).created).toHaveLength(0)
        expect(owner('/remind ab jetzt immer um acht').created).toHaveLength(0)
        expect(owner('Warum ist der Drucker immer so langsam?').created).toHaveLength(0)
        expect(owner('Das hat noch nie funktioniert.').created).toHaveLength(0)
        expect(listDecisions(opts)).toHaveLength(0)
    })

    it('Gegenprobe: ein Worker übernimmt nichts', () => {
        const worker = { ...opts, isMain: () => false }
        const result = observeOwnerMessage({ text: 'Ab jetzt Telegram nur am Main', permission: 'owner', principalId: 'alfred' }, worker)
        expect(result.skipped).toBe('kein Main')
        expect(recordCardDecision({ id: 'c1', art: 'install', titel: 'jq installieren', beleg: 'fehlt', answer: 'immer' }, worker)).toBeNull()
        expect(listDecisions(opts)).toHaveLength(0)
    })

    it('erkennt „immer“, „nie“ und „du entscheidest“', () => {
        const now = T0
        expect(parseOwnerDirectives('Druck nie ohne Knopf.', now)[0]).toMatchObject({ polaritaet: 'neg', wirkung: 'strenger', constraint: { mode: 'fragen', arten: ['drucken'] } })
        expect(parseOwnerDirectives('Du entscheidest ab jetzt selbst, welches Modell für Zusammenfassungen läuft.', now)[0]).toMatchObject({ wirkung: 'lockernd', wirksam: true })
        expect(parseOwnerDirectives('Antworte mir immer auf Deutsch.', now)).toHaveLength(1)
    })
})

describe('Ablauf und Widerruf', () => {
    it('„für 3 Tage“ läuft ab und fällt aus Kontext und Liste der gültigen', () => {
        owner('Ab jetzt für 3 Tage keine Modell-Wechsel.')
        expect(relevantDecisions('Soll ich das Modell wechseln', opts)).toHaveLength(1)
        clock = T0 + 3 * 24 * 3_600_000 + 1_000
        expect(relevantDecisions('Soll ich das Modell wechseln', opts)).toHaveLength(0)
        expect(listDecisions(opts)[0].status).toBe('abgelaufen')
        expect(activeConstraints(opts)).toHaveLength(0)
    })

    it('Widerruf im Chat und per Befehl', () => {
        owner('Ab jetzt Telegram nur am Main.')
        owner('Druck nie ohne Knopf.')
        const revoked = owner('Vergiss die Regel mit Telegram.')
        expect(revoked.revoked.map(item => item.text)).toEqual(['Telegram nur am Main'])
        const druck = listDecisions(opts).find(item => item.text.startsWith('Druck'))!
        expect(druck.status).toBe('aktiv')
        expect(handleEntscheidungenCommand(`widerruf ${druck.id}`, { permission: 'owner', principalId: 'alfred' }, opts)).toContain('Widerrufen')
        expect(listDecisions(opts).every(item => item.status === 'widerrufen')).toBe(true)
        expect(handleEntscheidungenCommand('', { permission: 'user' }, opts)).toContain('nur für den Owner')
    })

    it('Widerruf markiert abhängige Einträge zum Prüfen', () => {
        owner('Ab jetzt Release-Knopf per Deploy-Key.')
        const basis = listDecisions(opts)[0]
        const mission = recordMissionDecision({ id: 'm-000000000001', titel: 'Release ausrollen per Deploy-Key', status: 'abgeschlossen', grund: 'Tag v2.82.0 vorhanden' }, opts)!
        expect(mission.bindend).toBe(false)
        expect(mission.abhaengigVon).toEqual([basis.id])
        revokeDecision(basis.id, 'owner:alfred', opts)
        expect(listDecisions(opts).find(item => item.id === mission.id)!.statusGrund).toContain('prüfen')
    })
})

describe('Widersprüche', () => {
    it('widersprechende Anweisung → genau einmal nachfragen, Antwort klärt', () => {
        owner('Ab jetzt Telegram nur am Main, weil es nur einen Konsumenten gibt.')
        const result = owner('Ab jetzt immer Telegram auch am Pi5.')
        expect(result.conflicts).toHaveLength(1)
        expect(result.conflicts[0].alt.text).toBe('Telegram nur am Main')
        const block = buildDecisionContext('Ab jetzt immer Telegram auch am Pi5.', result, opts)
        expect(block).toContain('WIDERSPRUCH')
        expect(block).toContain('GENAU EINMAL')
        // die alte gilt bis zur Antwort
        expect(relevantDecisions('Telegram', opts).map(item => item.text)).toEqual(['Telegram nur am Main'])
        // eine fremde Folgenachricht stellt die Frage nicht erneut
        const other = owner('Wie spät ist es?')
        expect(other.conflicts).toHaveLength(0)
        expect(buildDecisionContext('Wie spät ist es?', other, opts)).not.toContain('WIDERSPRUCH')
        const answer = owner('Ja, die neue.')
        expect(answer.resolved?.gewinner).toBe('neu')
        const all = listDecisions(opts)
        expect(all.find(item => item.text === 'Telegram nur am Main')!.status).toBe('ersetzt')
        expect(all.find(item => item.text.startsWith('immer Telegram'))!.status).toBe('aktiv')
    })

    it('ausdrücklich („statt“, „nicht mehr“) → die neuere gewinnt sofort', () => {
        owner('Ab jetzt Telegram nur am Main.')
        const result = owner('Ab sofort gilt: Telegram nicht mehr nur am Main, sondern am Pi5.')
        expect(result.conflicts).toHaveLength(0)
        expect(result.replaced.map(item => item.text)).toEqual(['Telegram nur am Main'])
        expect(listDecisions(opts).filter(item => item.status === 'aktiv')).toHaveLength(1)
    })

    it('Gegenprobe: gleiche Anweisung nochmal → bestätigt, kein Duplikat, kein Widerspruch', () => {
        owner('Druck nie ohne Knopf.')
        const again = owner('Druck nie ohne Knopf!')
        expect(again.confirmed).toHaveLength(1)
        expect(again.conflicts).toHaveLength(0)
        expect(listDecisions(opts)).toHaveLength(1)
    })
})

describe('Nutzen beim Handeln', () => {
    it('passende Entscheidung landet im Kontext, unpassende nicht', () => {
        owner('Ab jetzt Telegram nur am Main, weil es nur einen Konsumenten gibt.')
        owner('Druck nie ohne Knopf.')
        const related = buildDecisionContext('Kann ich Telegram am Pi5 einschalten?', null, opts)
        expect(related).toContain('Telegram nur am Main')
        expect(related).toContain('Grund: es nur einen Konsumenten gibt')
        expect(related).toContain('gilt bis widerrufen')
        expect(related).not.toContain('Druck')
        expect(buildDecisionContext('Wie wird das Wetter in Salzburg?', null, opts)).toBe('')
    })

    it('verschärfende Entscheidung fließt in die Aktions-Policy ein (nur anheben)', () => {
        owner('Nie Modell wechseln ohne mich zu fragen.')
        owner('Ab jetzt nie Cache leeren.')
        const constraints = activeConstraints(opts)
        expect(evaluateAction({ kind: 'cache-leeren', origin: 'code' }).level).toBe('L1')
        expect(evaluateAction({ kind: 'cache-leeren', origin: 'code' }, { constraints })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'modell-wechseln', origin: 'code' }, { constraints }).level).toBe('L2')
        setDecisionConstraintProvider(() => constraints)
        expect(evaluateAction({ kind: 'cache-leeren', origin: 'code' }).reason).toContain('Entscheidung')
        // unbeteiligte Arten bleiben unverändert
        expect(evaluateAction({ kind: 'log-rotation', origin: 'code' }).level).toBe('L1')
    })
})

describe('Feste Grenzen', () => {
    it('Nie-Liste aufheben per Entscheidung → gespeichert, aber „nicht wirksam: feste Grenze“', () => {
        const result = owner('Ab jetzt darfst du Backups selbst löschen.')
        expect(result.created).toHaveLength(1)
        const [decision] = listDecisions(opts)
        expect(decision.wirksam).toBe(false)
        expect(decision.nichtWirksamGrund).toMatch(/^nicht wirksam: feste Grenze/)
        expect(decision.constraint).toBeUndefined()
        expect(buildDecisionContext('Backups löschen', result, opts)).toContain('nicht wirksam: feste Grenze')
        setDecisionConstraintProvider(() => activeConstraints(opts))
        expect(evaluateAction({ kind: 'daten-loeschen', origin: 'owner' }).level).toBe('L3')
        expect(evaluateAction({ kind: 'backup-loeschen', origin: 'code', effects: ['backup:loeschen'] }).decision).toBe('never')
    })

    it('Karten für physisch/extern/Geld abschalten → nicht wirksam, Knopf bleibt', () => {
        owner('Ab jetzt ohne Knopf drucken.')
        owner('Ab sofort darfst du Bestellungen bis 20 Euro automatisch bezahlen.')
        owner('Mails an Kunden schickst du ab jetzt ohne zu fragen.')
        const items = listDecisions(opts)
        expect(items).toHaveLength(3)
        expect(items.every(item => item.wirksam === false && /feste Grenze/.test(item.nichtWirksamGrund || ''))).toBe(true)
        setDecisionConstraintProvider(() => activeConstraints(opts))
        expect(evaluateAction({ kind: 'drucken', origin: 'code' })).toMatchObject({ level: 'L2', decision: 'ask' })
        expect(evaluateAction({ kind: 'mail-senden', origin: 'code' })).toMatchObject({ level: 'L2', decision: 'ask' })
    })

    it('Gegenprobe: eine harmlose lockernde Entscheidung ist wirksam (aber senkt kein Level)', () => {
        owner('Ab jetzt rotierst du Logs selbst.')
        const [decision] = listDecisions(opts)
        expect(decision.wirksam).toBe(true)
        setDecisionConstraintProvider(() => activeConstraints(opts))
        expect(evaluateAction({ kind: 'dienst-neustart', origin: 'code' }).level).toBe('L2')
    })

    it('keine Secrets gespeichert', () => {
        owner('Ab jetzt immer den NAS-Zugang mit Passwort Sonne-Mond-77 nutzen.')
        owner('Ab jetzt immer RELEASE_TOKEN=aaaaaaaaaaaaaaaaaaaa für Releases nehmen.')
        const raw = readFileSync(join(dir, 'decisions', 'decisions.json'), 'utf8')
        expect(raw).not.toContain('Sonne-Mond-77')
        expect(raw).not.toContain('aaaaaaaaaaaaaaaaaaaa')
        expect(raw).toContain('[REDACTED]')
    })

    it('Größe ist begrenzt: lange Texte gekürzt, zu lange Nachrichten ignoriert', () => {
        const long = `Ab jetzt immer ${'Dokumentation '.repeat(40)}`.slice(0, 700)
        owner(long)
        expect(listDecisions(opts)[0].text.length).toBeLessThanOrEqual(240)
        expect(owner(`Ab jetzt immer ${'x'.repeat(900)}`).created).toHaveLength(0)
    })
})

describe('weitere Quellen und Abendbericht', () => {
    it('Knopf „Immer erlauben“ / „Nein“ mit dem Beleg als Grund', () => {
        const immer = recordCardDecision({ id: 'ac1', art: 'install', titel: 'jq aus dem Katalog installieren', beleg: 'jq fehlt für Skript X', answer: 'immer', decidedBy: 'telegram:1' }, opts)!
        expect(immer).toMatchObject({ bindend: true, wirksam: true, quelle: { art: 'knopf', ref: 'ac1' } })
        expect(immer.warum).toContain('jq fehlt')
        const nein = recordCardDecision({ id: 'ac2', art: 'vm', titel: 'VM anlegen', beleg: 'zu wenig RAM', answer: 'nein' }, opts)!
        expect(nein.gueltigBis).toBe(new Date(T0 + 30 * 24 * 3_600_000).toISOString())
        expect(recordCardDecision({ id: 'ac3', art: 'x', titel: 'y', beleg: 'z', answer: 'ja' }, opts)).toBeNull()
    })

    it('Delegationsergebnis: nur die eigene Prüfung ist Beleg, nie die Antwort', () => {
        recordMissionDecision({ id: 'm-000000000002', titel: 'Knoten spark gesund halten', status: 'fehlgeschlagen', handoff: 'brauche dich' }, opts)
        const entry = recordDelegationDecision({ id: 'dlg-1', to: 'claude', auftrag: 'Release v2.82.0 bauen', status: 'fertig', missionId: 'm-000000000002', pruefung: { ergebnis: 'verifiziert', detail: 'Release existiert' } }, true, opts)!
        expect(entry.bindend).toBe(false)
        expect(entry.warum).toContain('eigene Prüfung: verifiziert')
        expect(entry.abhaengigVon).toHaveLength(1)
    })

    it('Abendbericht nennt neue Entscheidungen und nicht wirksame', () => {
        owner('Ab jetzt Telegram nur am Main, weil es nur einen Konsumenten gibt.')
        owner('Ab jetzt ohne Knopf drucken.')
        const lines = decisionsForBriefing(T0 - 1000, T0 + 1000, opts)
        expect(lines).toHaveLength(2)
        expect(lines[0]).toContain('gilt bis widerrufen')
        expect(lines[1]).toContain('nicht wirksam: feste Grenze')
    })
})
