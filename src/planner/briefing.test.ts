import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBriefing } from './briefing.js'
import type { DeliveryPort, PlannerOutgoing } from './delivery-port.js'
import { startPlannerRuntime, stopPlannerRuntime } from './runtime.js'
import { createThoughtStore } from './thoughts.js'

let dir: string
let t: number
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

function writeHeal(at: string, recipe: string, ergebnis: string, message: string) {
    const journal = join(dir, 'self-heal', 'journal')
    mkdirSync(journal, { recursive: true })
    appendFileSync(join(journal, `${at.slice(0, 10)}.jsonl`), `${JSON.stringify({
        id: `heal-${recipe}`, at, node: 'spark', recipe, level: 'auto', signature: `${recipe}:x`, befund: { token: SECRET },
        aktion: 'gzip', ergebnis, fence: { held: true, mode: 'observe', note: '' }, message,
    })}\n`)
}

function writeInstall(entry: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'install-journal.jsonl'), `${JSON.stringify(entry)}\n`)
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'briefing-'))
    t = Date.parse('2026-10-01T18:00:00.000Z') // 20:00 Vienna
})
afterEach(() => {
    stopPlannerRuntime()
    rmSync(dir, { recursive: true, force: true })
})

describe('Morgen-/Abendbericht', () => {
    it('P8: neue und deaktivierte Skills stehen als eigene Zeilen im Abendbericht', () => {
        const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
        const neu = thoughts.add({ source: 'skills', kind: 'ereignis', permission: 'selbst', title: 'Neuer Skill „Routine: wetter salzburg“ angelegt', evidence: '3× gleiche Absicht' }).thought
        thoughts.setStatus(neu.id, 'erledigt', 'selbst')
        thoughts.add({ source: 'skills', kind: 'ereignis', permission: 'selbst', title: 'Skill „Routine: drucker“ deaktiviert', evidence: '2 Fehlschläge in Folge' })
        const briefing = buildBriefing('abend', {
            dataDir: dir, thoughts, runsFile: join(dir, 'planner', 'runs.jsonl'), timeZone: 'Europe/Vienna',
        }, Date.parse('2026-10-01T05:30:00.000Z'), t)
        expect(briefing.text).toContain('Skills:')
        expect(briefing.text).toContain('Neuer Skill „Routine: wetter salzburg“ angelegt')
        expect(briefing.text).toContain('Skill „Routine: drucker“ deaktiviert (2 Fehlschläge in Folge)')
        expect(briefing.text).not.toContain('Erledigt:')
        expect(briefing.counts.skills).toBe(2)
    })

    it('2.84: eine zurückgehaltene Frage steht nur unter „Wartet auf dich“, nicht zusätzlich unter „Zurückgehalten“', () => {
        const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
        const frage = thoughts.add({ source: 'scout', kind: 'vorschlag', title: 'Qwen2.5-VL 3B auf xaventra-ns1?', proposal: 'Katalog ollama-model', permission: 'fragen' }).thought
        thoughts.markNotice(frage.id, 'zurueckgehalten', 'ruhezeit')
        const ereignis = thoughts.add({ source: 'waechter', kind: 'ereignis', title: 'NAS langsam', permission: 'selbst', severity: 'warning' }).thought
        thoughts.markNotice(ereignis.id, 'zurueckgehalten', 'ruhezeit')
        const briefing = buildBriefing('morgen', {
            dataDir: dir, thoughts, runsFile: join(dir, 'planner', 'runs.jsonl'), timeZone: 'Europe/Vienna',
        }, Date.parse('2026-10-01T05:30:00.000Z'), t)
        expect(briefing.text.split('Qwen2.5-VL 3B').length - 1).toBe(1)
        expect(briefing.text).toContain('Wartet auf dich')
        expect(briefing.text).toContain('NAS langsam (Ruhezeit)')
        expect(briefing.counts.zurueckgehalten).toBe(1)
        // both are still marked as reported after delivery
        expect(briefing.thoughtIds).toEqual(expect.arrayContaining([frage.id, ereignis.id]))
    })

    it('enthält echte Journal-Einträge, wartende Fragen und Ideen, aber keine Secrets', () => {
        writeHeal('2026-10-01T10:00:00.000Z', 'log-rotation', 'geheilt', `audit.log archiviert (1.2 GB) GITHUB_TOKEN=${SECRET}`)
        writeHeal('2026-09-20T10:00:00.000Z', 'cache-leeren', 'geheilt', 'alt, gehört nicht in den Bericht')
        writeInstall({ at: '2026-10-01T09:00:00.000Z', event: 'proposed', id: 'iq-aaaaaaaaaaaa', catalogId: 'ffmpeg', nodeId: 'spark' })
        writeInstall({ at: '2026-10-01T09:01:00.000Z', event: 'install-ticket', id: 'iq-aaaaaaaaaaaa', ticketId: 't1', catalogId: 'ffmpeg', approvedBy: 'owner:alfred' })
        writeInstall({ at: '2026-10-01T09:02:00.000Z', event: 'install-receipt', id: 'iq-aaaaaaaaaaaa', ticketId: 't1', success: true, evidenceHash: 'abc' })
        const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
        thoughts.add({ source: 'install', kind: 'vorschlag', title: 'XFCE installieren?', proposal: 'Katalog xfce-workstation', permission: 'fragen' })
        thoughts.add({ source: 'idee', kind: 'idee', title: 'web_search cachen', evidence: '3x langsamer seit 7 Tagen' })
        const done = thoughts.add({ source: 'planer', title: 'Backup geprüft' }).thought
        thoughts.setStatus(done.id, 'erledigt', 'owner')

        const briefing = buildBriefing('abend', {
            dataDir: dir, thoughts, runsFile: join(dir, 'planner', 'runs.jsonl'), timeZone: 'Europe/Vienna',
        }, Date.parse('2026-10-01T05:30:00.000Z'), t)

        expect(briefing.title).toMatch(/^Abendbericht/)
        expect(briefing.text).toContain('Selbst repariert')
        expect(briefing.text).toContain('log-rotation')
        expect(briefing.text).toContain('audit.log archiviert')
        expect(briefing.text).not.toContain('alt, gehört nicht')
        expect(briefing.text).toContain('Installiert')
        expect(briefing.text).toContain('ffmpeg')
        expect(briefing.text).toContain('Wartet auf dich')
        expect(briefing.text).toContain('XFCE installieren?')
        expect(briefing.text).toContain('Ideen')
        expect(briefing.text).toContain('web_search cachen')
        expect(briefing.text).toContain('Backup geprüft')
        expect(briefing.text).not.toContain(SECRET)
        expect(briefing.text.length).toBeLessThan(2500)
    })

    it('sagt ehrlich, wenn nichts passiert ist', () => {
        const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
        const briefing = buildBriefing('morgen', { dataDir: dir, thoughts, runsFile: join(dir, 'nope.jsonl'), timeZone: 'Europe/Vienna' }, t - 3_600_000, t)
        expect(briefing.title).toMatch(/^Morgenbericht/)
        expect(briefing.text).toMatch(/Nichts Neues/)
    })

    it('ist mit briefing.enabled=false aus (P8: ohne Config an) und läuft mit Schalter genau einmal zur eingestellten Zeit über den Port', async () => {
        const sent: PlannerOutgoing[] = []
        const port: DeliveryPort = { name: 'test-port', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }
        t = Date.parse('2026-10-01T16:00:00.000Z') // 18:00 Vienna

        const off = await startPlannerRuntime({ planner: { enabled: true }, briefing: { enabled: false } }, { dataDir: dir, now: () => t, authority: () => true, startTimer: false, port })
        t = Date.parse('2026-10-01T18:01:00.000Z')
        await off!.planner.tick()
        expect(sent).toHaveLength(0)
        expect(off!.planner.getJob('sys-briefing-abend')?.enabled).toBe(false)
        stopPlannerRuntime()

        t = Date.parse('2026-10-01T16:00:00.000Z')
        const on = await startPlannerRuntime({ briefing: { enabled: true, evening: '20:00', morning: '07:00' } }, { dataDir: dir, now: () => t, authority: () => true, startTimer: false, port })
        await on!.planner.tick()
        expect(sent).toHaveLength(0)
        t = Date.parse('2026-10-01T18:00:30.000Z')
        await on!.planner.tick()
        await on!.planner.tick()
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ kind: 'briefing' })
        expect(sent[0].title).toMatch(/^Abendbericht/)
    })
})
