import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeliveryPort, PlannerOutgoing } from './delivery-port.js'
import { createPlanner } from './planner.js'
import { createThoughtStore, deliverPendingThoughts, isQuietHour, rateImportance } from './thoughts.js'

let dir: string
let t: number
// 2026-10-01T08:00Z = 10:00 Vienna (day); 2026-10-01T21:30Z = 23:30 Vienna (quiet).
const DAY = Date.parse('2026-10-01T08:00:00.000Z')
const NIGHT = Date.parse('2026-10-01T21:30:00.000Z')

function port() {
    const sent: PlannerOutgoing[] = []
    const value: DeliveryPort = { name: 'test-port', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }
    return { port: value, sent }
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'thoughts-'))
    t = DAY
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const store = (settings: Record<string, number> = {}) => createThoughtStore({ dataDir: dir, now: () => t, settings })

describe('Gedanken: Wichtigkeit aus festen Regeln', () => {
    it('leitet die Wichtigkeit nur aus Schwere und Art ab', () => {
        expect(rateImportance({ severity: 'critical', kind: 'ereignis', permission: 'selbst' }).importance).toBe('dringend')
        expect(rateImportance({ severity: 'warning', kind: 'ereignis', permission: 'selbst' }).importance).toBe('wichtig')
        expect(rateImportance({ kind: 'vorschlag', permission: 'fragen' }).importance).toBe('wichtig')
        expect(rateImportance({ kind: 'idee', permission: 'selbst' }).importance).toBe('niedrig')
        expect(rateImportance({ kind: 'ereignis', permission: 'selbst' }).importance).toBe('normal')
    })

    it('legt Gedanken mit Code-ID an, ignoriert eine mitgegebene Wichtigkeit und schwärzt Secrets', () => {
        const s = store()
        const { thought } = s.add({ source: 'nachtwache', title: 'Platte voll', evidence: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', severity: 'warning', id: 'th-evil', importance: 'dringend' } as any)
        expect(thought.id).toMatch(/^th-[a-f0-9]{12}$/)
        expect(thought.importance).toBe('wichtig')
        expect(thought.rule).toBe('regel:warnung')
        expect(thought.status).toBe('offen')
        expect(thought.evidence).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
        expect(readFileSync(join(dir, 'thoughts', 'thoughts.json'), 'utf8')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    })

    it('Status und Erlaubnis sind auf feste Werte begrenzt', () => {
        const s = store()
        const { thought } = s.add({ source: 'install', kind: 'vorschlag', title: 'ffmpeg installieren', proposal: '/install ffmpeg' })
        expect(thought.permission).toBe('fragen')
        expect(s.setStatus(thought.id, 'kaputt' as any, 'owner')).toBeNull()
        expect(s.setStatus(thought.id, 'wartet-auf-knopf', 'karte')?.status).toBe('wartet-auf-knopf')
        expect(s.setStatus(thought.id, 'erledigt', 'owner')?.status).toBe('erledigt')
        expect(s.list({ status: 'offen' })).toHaveLength(0)
        expect(s.list()).toHaveLength(1)
        expect(() => s.add({ source: 'Böse Quelle', title: 'x' })).toThrow()
    })
})

describe('Gedanken: Entprellen', () => {
    it('gleiche Signatur innerhalb des Fensters ergibt einen Gedanken und eine Meldung', async () => {
        const s = store({ dedupeMinutes: 60 })
        const { port: p, sent } = port()
        const a = s.add({ source: 'nachtwache', title: 'Dienst X down', severity: 'warning', signature: 'nw:x' })
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        t += 10 * 60_000
        const b = s.add({ source: 'nachtwache', title: 'Dienst X down', severity: 'warning', signature: 'nw:x' })
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        expect(b.deduped).toBe(true)
        expect(b.thought.id).toBe(a.thought.id)
        expect(b.thought.seen).toBe(2)
        expect(sent).toHaveLength(1)
        expect(s.list()).toHaveLength(1)

        // After the window the still-open thought is announced once more.
        t += 61 * 60_000
        s.add({ source: 'nachtwache', title: 'Dienst X down', severity: 'warning', signature: 'nw:x' })
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        expect(sent).toHaveLength(2)
    })

    it('steigt die Wichtigkeit auf dringend, wird sofort erneut gemeldet', async () => {
        const s = store({ dedupeMinutes: 60 })
        const { port: p, sent } = port()
        s.add({ source: 'nachtwache', title: 'Dienst X', severity: 'warning', signature: 'nw:x' })
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        t += 60_000
        s.add({ source: 'nachtwache', title: 'Dienst X', severity: 'critical', signature: 'nw:x' })
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        expect(sent.map(msg => msg.urgency)).toEqual(['normal', 'dringend'])
    })
})

describe('Gedanken: Ruhezeit und Tagesobergrenze', () => {
    it('Ruhezeit 22–7 (Wien) hält Unwichtiges zurück, Dringendes geht durch', async () => {
        t = NIGHT
        const s = store()
        expect(isQuietHour(t, s.settings)).toBe(true)
        expect(isQuietHour(DAY, s.settings)).toBe(false)
        const { port: p, sent } = port()
        const quiet = s.add({ source: 'nachtwache', title: 'Warnung', severity: 'warning' }).thought
        const urgent = s.add({ source: 'nachtwache', title: 'Kritisch', severity: 'critical' }).thought
        const result = await deliverPendingThoughts(s, p, { briefingEnabled: true })
        expect(sent.map(msg => msg.thoughtId)).toEqual([urgent.id])
        expect(result).toMatchObject({ sent: 1, held: 1 })
        expect(s.get(quiet.id)).toMatchObject({ notice: 'zurueckgehalten', noticeReason: 'ruhezeit' })
    })

    it('ohne Bericht wartet die zurückgehaltene Meldung bis nach der Ruhezeit', async () => {
        t = NIGHT
        const s = store()
        const { port: p, sent } = port()
        const quiet = s.add({ source: 'nachtwache', title: 'Warnung', severity: 'warning' }).thought
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        expect(sent).toHaveLength(0)
        expect(s.get(quiet.id)?.notice).toBe('ausstehend')
        t = Date.parse('2026-10-02T05:30:00.000Z') // 07:30 Vienna
        await deliverPendingThoughts(s, p, { briefingEnabled: false })
        expect(sent).toHaveLength(1)
    })

    it('Tagesobergrenze: darüber nur noch Dringendes, Rest wartet auf den Bericht', async () => {
        const s = store({ maxPerDay: 2 })
        const { port: p, sent } = port()
        // Distinct things (digits alone do not make a new signature: "Platte 91%" = "Platte 92%").
        const ids = ['A', 'B', 'C'].map(n => s.add({ source: 'nachtwache', title: `Warnung ${n}`, severity: 'warning' }).thought.id)
        const urgent = s.add({ source: 'nachtwache', title: 'Kritisch', severity: 'critical' }).thought.id
        const result = await deliverPendingThoughts(s, p, { briefingEnabled: true })
        expect(sent.map(msg => msg.thoughtId)).toEqual([urgent, ids[0]])
        expect(result.limited).toBe(2)
        expect(s.get(ids[2])).toMatchObject({ notice: 'zurueckgehalten', noticeReason: 'tageslimit' })
        // A new day resets the budget.
        t += 24 * 3_600_000
        s.add({ source: 'nachtwache', title: 'Neu', severity: 'warning' })
        await deliverPendingThoughts(s, p, { briefingEnabled: true })
        expect(sent).toHaveLength(3)
    })

    it('Gedanken werden nur auf dem Main gemeldet (Planer-Tick)', async () => {
        let isMain = false
        const { port: p, sent } = port()
        const s = store()
        const planner = createPlanner({ dataDir: dir, now: () => t, authority: () => isMain, ports: { default: () => p }, thoughts: s })
        s.add({ source: 'nachtwache', title: 'Kritisch', severity: 'critical' })
        await planner.tick()
        expect(sent).toHaveLength(0)
        isMain = true
        await planner.tick()
        expect(sent).toHaveLength(1)
        const log = readFileSync(planner.paths.deliveries, 'utf8')
        expect(log).toContain('"kind":"gedanke"')
        expect(existsSync(planner.paths.deliveries)).toBe(true)
    })
})
