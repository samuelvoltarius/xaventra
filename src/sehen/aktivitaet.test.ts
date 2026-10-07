import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aktivitaetText, ladeSpaeter, sammleAktivitaet, steuereAktivitaet, type AktivitaetQuellen } from './aktivitaet.js'

// 2.88 „Aktivität“: eine Liste aus den vorhandenen Quellen; jeder Knopf ruft
// genau die vorhandene Funktion der Quelle. Nur Testdaten, kein Netz.
let dir = ''
let t = 0
let calls: string[] = []
let jobs: any[] = []
let auftrag: any = null
let responsibilities: any[] = []
let missions: any[] = []
let subagents: any[] = []
let delegations: any[] = []
let thoughts: any[] = []

const q = (): AktivitaetQuellen => ({
    dataDir: dir, now: () => t, nodeId: () => 'main-a',
    aufgaben: async () => [],
    aktuelleAufgabe: async () => ({ status: 'active', summary: 'Doku zu ESPHome finden', channel: 'telegram', startedAt: t - 30_000, currentStep: 1, steps: [{ description: 'Anfrage verstehen' }, { description: 'Browser: suche Doku zu ESPHome' }, { description: 'Antwort schreiben' }] }),
    auftrag: async () => auftrag,
    arbeit: async () => ({ missions, responsibilities }),
    subagenten: async () => subagents,
    delegationen: async () => delegations,
    jobs: async () => jobs,
    auftragStopp: async () => { calls.push('auftrag:stopp'); auftrag = null; return '🛑 Auftrag abgebrochen' },
    auftragPause: async () => { calls.push('auftrag:pause'); auftrag = { ...auftrag, status: 'paused' }; return '⏸️ pausiert' },
    auftragWeiter: async () => { calls.push('auftrag:weiter'); auftrag = { ...auftrag, status: 'active' }; return '▶️ weiter' },
    verantwortungPause: async (id, paused, by) => {
        calls.push(`verantwortung:${id}:${paused}:${by}`)
        const item = responsibilities.find(entry => entry.id === id)
        if (!item) return { ok: false, message: 'Unbekannte Verantwortung.' }
        item.status = paused ? 'pausiert' : 'aktiv'
        return { ok: true, message: 'ok' }
    },
    subagentStopp: async id => { calls.push(`subagent:${id}`); return true },
    delegationZurueck: async (id, grund) => { calls.push(`delegation:${id}:${grund}`); return { ok: true, message: 'ok' } },
    jobAn: async (id, an) => { calls.push(`job:${id}:${an}`); const job = jobs.find(entry => entry.id === id); if (job) job.enabled = an; return Boolean(job) },
    gedanke: async input => { thoughts.push(input); return true },
})

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aktivitaet-'))
    t = Date.parse('2026-10-07T09:00:00.000Z')
    calls = []; thoughts = []
    auftrag = { id: 'mission_1', summary: 'Website', status: 'active', currentStep: 3, channel: 'desktop', createdAt: t - 600_000,
        steps: [1, 2, 3, 4, 5, 6, 7].map(n => ({ description: `Schritt ${n}`, status: n <= 3 ? 'done' : 'pending' })) }
    responsibilities = [{ id: 'resp-platten', titel: 'Platten nicht voll laufen lassen', ziel: 'unter 85 %', status: 'aktiv', herkunft: 'owner' }]
    missions = [{ id: 'm-000000000001', responsibilityId: 'resp-platten', titel: 'Platz auf worker-a schaffen', status: 'in-arbeit', cursor: 1, node: 'worker-a',
        steps: [{ titel: 'messen', status: 'erledigt' }, { titel: 'Logs rotieren', status: 'laeuft', node: 'worker-a' }, { titel: 'nachmessen', status: 'offen' }], anlass: ['/ zu 91 % voll'], createdAt: new Date(t - 60_000).toISOString() }]
    subagents = [{ id: 'sub_1', task: 'Preise vergleichen', status: 'running', durationMs: 5_000 }]
    delegations = [{ id: 'dlg-1', to: 'claude', auftrag: 'Release bauen', status: 'wartet-auf-freigabe', updatedAt: new Date(t).toISOString() }]
    jobs = [
        { id: 'sys-waechter', kind: 'waechter', title: 'Wächter', enabled: true, status: 'aktiv', nextRunAt: new Date(t + 300_000).toISOString(), schedule: { type: 'intervall', minutes: 5 } },
        { id: 'job-0123456789ab', kind: 'erinnerung', title: 'Müll rausbringen', enabled: true, status: 'aktiv', nextRunAt: new Date(t + 3_600_000).toISOString(), schedule: { type: 'taeglich', time: '19:00' } },
        { id: 'job-abcdefabcdef', kind: 'ideen-lernen', title: 'Aus dem Tag lernen', enabled: true, status: 'aktiv', nextRunAt: new Date(t + 7_200_000).toISOString(), schedule: { type: 'taeglich', time: '03:00' } },
    ]
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('eine Liste aus den vorhandenen Quellen', () => {
    it('zeigt was sie gerade tut, mit Status, Node und Grund', async () => {
        const view = await sammleAktivitaet(q())
        const byId = Object.fromEntries(view.eintraege.map(item => [item.id, item]))
        expect(byId['aufgabe:' + String(t - 30_000)]).toMatchObject({ tut: 'Browser: suche Doku zu ESPHome (2/3)', status: 'laeuft', jetzt: true, aktionen: ['anders'] })
        expect(byId['auftrag:mission_1']).toMatchObject({ artText: 'Projekt', status: 'laeuft', aktionen: ['stopp', 'spaeter', 'anders'] })
        expect(byId['auftrag:mission_1'].tut).toMatch(/^Projekt Website 4\/7: Schritt 4/)
        expect(byId['mission:m-000000000001']).toMatchObject({ node: 'worker-a', grund: '/ zu 91 % voll' })
        expect(byId['mission:m-000000000001'].tut).toBe('Projekt Platz auf worker-a schaffen 2/3: Logs rotieren')
        expect(byId['verantwortung:resp-platten']).toMatchObject({ grund: 'Du hast es ihr aufgetragen' })
        expect(byId['subagent:sub_1']).toMatchObject({ artText: 'Helfer', aktionen: ['stopp', 'anders'] })
        expect(byId['delegation:dlg-1']).toMatchObject({ status: 'wartet', node: 'claude' })
        expect(byId['waechter:sys-waechter']).toMatchObject({ artText: 'Wächter', grund: 'Grundfunktion', aktionen: ['spaeter', 'anders'] })
        expect(byId['lernen:job-abcdefabcdef']).toMatchObject({ artText: 'Lernen' })
        expect(byId['geplant:job-0123456789ab']).toMatchObject({ tut: 'geplant täglich 19:00' })
        // Laufendes zuerst.
        expect(view.eintraege[0].jetzt).toBe(true)
        expect(view.probleme).toEqual([])
    })

    it('fällt eine Quelle aus, bleibt die Liste stehen und nennt den Grund', async () => {
        const view = await sammleAktivitaet({ ...q(), subagenten: async () => { throw new Error('weg') } })
        expect(view.eintraege.length).toBeGreaterThan(3)
        expect(view.probleme).toEqual(['Helfer: weg'])
    })

    it('Telegram-Text: eine Seite, „was ich gerade tue“', async () => {
        const text = aktivitaetText(await sammleAktivitaet(q()))
        expect(text).toMatch(/Browser: suche Doku zu ESPHome/)
        expect(text).toMatch(/Projekt Website 4\/7/)
        expect(text.length).toBeLessThan(3500)
    })
})

describe('Stopp, Später, Anders – jeweils die vorhandene Funktion', () => {
    it('Stopp beim Projekt bricht den Auftrag ab', async () => {
        const r = await steuereAktivitaet('auftrag:mission_1', 'stopp', { by: 'owner:1' }, q())
        expect(r).toMatchObject({ ok: true })
        expect(calls).toEqual(['auftrag:stopp'])
    })

    it('Stopp bei Mission pausiert die Verantwortung dahinter; Helfer und Übergabe nutzen cancel/withdraw', async () => {
        expect((await steuereAktivitaet('mission:m-000000000001', 'stopp', { by: 'owner:1' }, q())).ok).toBe(true)
        expect((await steuereAktivitaet('subagent:sub_1', 'stopp', { by: 'owner:1' }, q())).ok).toBe(true)
        expect((await steuereAktivitaet('delegation:dlg-1', 'stopp', { by: 'owner:1' }, q())).ok).toBe(true)
        expect(calls).toEqual(['verantwortung:resp-platten:true:owner:1', 'subagent:sub_1', 'delegation:dlg-1:vom Owner gestoppt (owner:1)'])
    })

    it('Grundfunktionen lassen sich nicht abschalten, nur verschieben', async () => {
        const r = await steuereAktivitaet('waechter:sys-waechter', 'stopp', { by: 'owner:1' }, q())
        expect(r.ok).toBe(false)
        expect(r.message).toMatch(/Grundfunktion/)
        expect(calls).toEqual([])
    })

    it('Später pausiert, merkt sich die Zeit und setzt danach genau das fort', async () => {
        const r = await steuereAktivitaet('geplant:job-0123456789ab', 'spaeter', { by: 'owner:1' }, q())
        expect(r).toMatchObject({ ok: true })
        expect(r.message).toMatch(/1 Stunde/)
        expect(calls).toEqual(['job:job-0123456789ab:false'])
        let view = await sammleAktivitaet(q())
        expect(view.eintraege.find(item => item.id === 'geplant:job-0123456789ab')).toMatchObject({ status: 'spaeter', aktionen: ['weiter', 'anders'] })
        t += 59 * 60_000
        await sammleAktivitaet(q())
        expect(calls).toEqual(['job:job-0123456789ab:false'])
        t += 2 * 60_000
        view = await sammleAktivitaet(q())
        expect(calls).toEqual(['job:job-0123456789ab:false', 'job:job-0123456789ab:true'])
        expect(view.eintraege.find(item => item.id === 'geplant:job-0123456789ab')?.status).toBe('geplant')
        expect(ladeSpaeter(dir)).toEqual([])
    })

    it('Später beim Projekt = Pause; „Weiter“ setzt sofort fort', async () => {
        await steuereAktivitaet('auftrag:mission_1', 'spaeter', { by: 'owner:1', minuten: 30 }, q())
        expect(calls).toEqual(['auftrag:pause'])
        expect(ladeSpaeter(dir)[0]).toMatchObject({ id: 'auftrag:mission_1', bis: new Date(t + 30 * 60_000).toISOString() })
        expect((await steuereAktivitaet('auftrag:mission_1', 'weiter', { by: 'owner:1' }, q())).ok).toBe(true)
        expect(calls).toEqual(['auftrag:pause', 'auftrag:weiter'])
        expect(ladeSpaeter(dir)).toEqual([])
    })

    it('„Weiter“ setzt nur fort, was pausiert ist', async () => {
        expect((await steuereAktivitaet('auftrag:mission_1', 'weiter', { by: 'owner:1' }, q())).ok).toBe(false)
        expect(calls).toEqual([])
    })

    it('Anders: … geht als Gedanke an den Planer, ohne etwas anzuhalten', async () => {
        const r = await steuereAktivitaet('auftrag:mission_1', 'anders', { by: 'owner:1', text: 'Nimm lieber das helle Design' }, q())
        expect(r.ok).toBe(true)
        expect(thoughts).toEqual([{ title: 'Anders: Website', evidence: 'Owner lenkt um (Projekt, läuft): „Nimm lieber das helle Design“', proposal: 'Nimm lieber das helle Design', node: 'main-a' }])
        expect(calls).toEqual([])
        expect((await steuereAktivitaet('auftrag:mission_1', 'anders', { by: 'owner:1', text: '' }, q())).ok).toBe(false)
    })

    it('Unbekanntes und Pfad-Tricks werden abgelehnt', async () => {
        for (const id of ['../etc', 'auftrag:', 'foo:bar', 'auftrag:mission_9']) expect((await steuereAktivitaet(id, 'stopp', { by: 'owner:1' }, q())).ok).toBe(false)
        expect((await steuereAktivitaet('auftrag:mission_1', 'loeschen', { by: 'owner:1' }, q())).ok).toBe(false)
        expect(calls).toEqual([])
    })

    it('eine laufende Chat-Antwort kann man nur umlenken', async () => {
        const id = `aufgabe:${t - 30_000}`
        expect((await steuereAktivitaet(id, 'stopp', { by: 'owner:1' }, q())).ok).toBe(false)
        expect((await steuereAktivitaet(id, 'anders', { by: 'owner:1', text: 'kürzer bitte' }, q())).ok).toBe(true)
    })
})
