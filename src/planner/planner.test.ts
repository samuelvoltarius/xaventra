import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FenceError } from '../mesh/fence.js'
import type { DeliveryPort, DeliveryReceipt, PlannerOutgoing } from './delivery-port.js'
import { createPlanner, type Planner, type PlannerDeps } from './planner.js'
import { nextDailySlot } from './time.js'

let dir: string
let t: number
let isMain: boolean
let runs: number

const lines = (file: string): any[] => existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []

function fakePort(behaviour?: (msg: PlannerOutgoing) => DeliveryReceipt | Error | undefined) {
    const sent: PlannerOutgoing[] = []
    const port: DeliveryPort = {
        name: 'test-port',
        deliver: async msg => {
            const result = behaviour?.(msg)
            if (result instanceof Error) throw result
            if (result) return result
            sent.push(msg)
            return { status: 'zugestellt' }
        },
    }
    return { port, sent }
}

function make(port: DeliveryPort | null, extra: Partial<PlannerDeps> = {}): Planner {
    const planner = createPlanner({ dataDir: dir, now: () => t, authority: () => isMain, nodeId: 'test-node', ports: { default: () => port }, ...extra })
    planner.register('test', {
        run: async () => {
            runs++
            return { summary: `Lauf ${runs}`, outgoing: { kind: 'job', title: 'Test', text: `Lauf ${runs}`, urgency: 'normal' } }
        },
    })
    planner.register('still', { run: async () => { runs++; return { summary: 'still' } } })
    return planner
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'planner-'))
    t = Date.parse('2026-10-01T08:00:00.000Z')
    isMain = true
    runs = 0
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Planer: fälliger Job läuft genau einmal und wird protokolliert', () => {
    it('führt einen einmaligen Job erst bei Fälligkeit und dann nie wieder aus', async () => {
        const { port, sent } = fakePort()
        const planner = make(port)
        const job = planner.addJob({ kind: 'test', title: 'Einmal', schedule: { type: 'einmal', at: new Date(t + 60_000).toISOString() }, delivers: true })
        expect(job.id).toMatch(/^job-[a-f0-9]{12}$/)

        await planner.tick()
        expect(runs).toBe(0)

        t += 61_000
        await planner.tick()
        await planner.tick()
        t += 3_600_000
        await planner.tick()

        expect(runs).toBe(1)
        expect(sent).toHaveLength(1)
        expect(planner.getJob(job.id)).toMatchObject({ status: 'erledigt', nextRunAt: null, lastStatus: 'zugestellt', runs: 1 })
        const runLog = lines(planner.paths.runs)
        expect(runLog).toHaveLength(1)
        expect(runLog[0]).toMatchObject({ jobId: job.id, ergebnis: 'ok', node: 'test-node' })
        const deliveryLog = lines(planner.paths.deliveries)
        expect(deliveryLog).toHaveLength(1)
        expect(deliveryLog[0]).toMatchObject({ jobId: job.id, status: 'zugestellt', port: 'test-port' })
    })

    it('übernimmt keine Job-ID vom Aufrufer (IDs erzeugt der Code)', () => {
        const planner = make(null)
        const job = planner.addJob({ id: 'job-../../etc', kind: 'test', title: 'x', schedule: { type: 'intervall', minutes: 5 } } as any)
        expect(job.id).toMatch(/^job-[a-f0-9]{12}$/)
    })

    it('Neustart nach Zustellung: neue Instanz führt nichts doppelt aus', async () => {
        const { port, sent } = fakePort()
        const first = make(port)
        const job = first.addJob({ kind: 'test', title: 'Einmal', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        await first.tick()
        first.stop()

        const second = make(port)
        await second.tick()
        t += 120_000
        await second.tick()
        expect(runs).toBe(1)
        expect(sent).toHaveLength(1)
        expect(second.getJob(job.id)?.status).toBe('erledigt')
    })

    it('Absturz nach Zustellung, vor dem Abschluss: Zustellprotokoll verhindert die Doppelmeldung', async () => {
        // First instance runs the job but cannot deliver (no port): pending stays.
        const first = make(null)
        const job = first.addJob({ kind: 'test', title: 'Einmal', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        await first.tick()
        const pending = first.getJob(job.id)!.pending!
        expect(pending.slot).toBe(new Date(t).toISOString())
        // Simulated crash right after a successful delivery was logged.
        appendFileSync(first.paths.deliveries, `${JSON.stringify({ at: new Date(t).toISOString(), jobId: job.id, slot: pending.slot, status: 'zugestellt', port: 'telegram' })}\n`)

        t += 200_000 // old lease expired
        const { port, sent } = fakePort()
        const second = make(port)
        await second.tick()
        expect(sent).toHaveLength(0)
        expect(runs).toBe(1)
        expect(second.getJob(job.id)).toMatchObject({ status: 'erledigt', lastStatus: 'zugestellt' })
    })

    it('Absturz während des Laufs: unterbrochener Lauf wird protokolliert, nicht wiederholt', async () => {
        const planner = make(null)
        const job = planner.addJob({ kind: 'still', title: 'Intervall', schedule: { type: 'intervall', minutes: 30 } })
        const raw = JSON.parse(readFileSync(planner.paths.jobs, 'utf8'))
        raw.jobs[0].claim = { slot: raw.jobs[0].nextRunAt, runId: 'run-abcdefabcdef', at: new Date(t).toISOString() }
        writeFileSync(planner.paths.jobs, JSON.stringify(raw))

        const restarted = make(null)
        await restarted.tick()
        expect(runs).toBe(0)
        expect(lines(restarted.paths.runs)[0]).toMatchObject({ jobId: job.id, ergebnis: 'unterbrochen' })
        expect(Date.parse(restarted.getJob(job.id)!.nextRunAt!)).toBe(t + 30 * 60_000)
    })
})

describe('Planer: nur der Main stellt zu', () => {
    it('ein Worker führt zustellende Jobs nicht aus, nicht zustellende schon', async () => {
        isMain = false
        const { port, sent } = fakePort()
        const planner = make(port)
        const delivering = planner.addJob({ kind: 'test', title: 'Meldung', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        const mainOnly = planner.addJob({ kind: 'still', title: 'Nur Main', schedule: { type: 'einmal', at: new Date(t).toISOString() }, mainOnly: true })
        const local = planner.addJob({ kind: 'still', title: 'Lokal', schedule: { type: 'einmal', at: new Date(t).toISOString() } })

        const report = await planner.tick()
        expect(report.skippedWorker.sort()).toEqual([delivering.id, mainOnly.id].sort())
        expect(sent).toHaveLength(0)
        expect(runs).toBe(1)
        expect(planner.getJob(local.id)?.status).toBe('erledigt')
        expect(planner.getJob(delivering.id)?.status).toBe('aktiv')

        isMain = true
        await planner.tick()
        expect(sent).toHaveLength(1)
        expect(planner.getJob(delivering.id)?.status).toBe('erledigt')
    })

    it('ein nicht zustellender Job kann keine Meldung verschicken', async () => {
        const { port, sent } = fakePort()
        const planner = make(port)
        planner.addJob({ kind: 'test', title: 'stumm', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: false })
        await planner.tick()
        expect(runs).toBe(1)
        expect(sent).toHaveLength(0)
    })

    it('Fence-Ablehnung zählt nicht als Fehlversuch; der Job wird nur einmal ausgeführt', async () => {
        let fenced = true
        const { port, sent } = fakePort(() => fenced ? new FenceError('telegram', 'kein Main', 'planner') : undefined)
        const planner = make(port)
        const job = planner.addJob({ kind: 'test', title: 'Meldung', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        for (let tick = 0; tick < 8; tick++) { await planner.tick(); t += 30_000 }
        expect(planner.getJob(job.id)).toMatchObject({ status: 'aktiv' })
        expect(planner.getJob(job.id)?.pending?.attempts).toBe(0)
        fenced = false
        await planner.tick()
        expect(sent).toHaveLength(1)
        expect(runs).toBe(1)
        expect(lines(planner.paths.deliveries).filter(entry => entry.status === 'fence')).toHaveLength(8)
    })

    it('gibt nach 5 echten Fehlversuchen auf', async () => {
        const { port } = fakePort(() => new Error('kaputt'))
        const planner = make(port)
        const job = planner.addJob({ kind: 'test', title: 'Meldung', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        for (let tick = 0; tick < 7; tick++) await planner.tick()
        expect(planner.getJob(job.id)).toMatchObject({ status: 'aufgegeben', lastStatus: 'aufgegeben' })
        expect(lines(planner.paths.deliveries).filter(entry => entry.status === 'fehler')).toHaveLength(5)
    })

    it('zwei Prozesse auf demselben Datenverzeichnis: nur der Lease-Halter tickt', async () => {
        const { port, sent } = fakePort()
        const a = make(port)
        const b = make(port)
        a.addJob({ kind: 'test', title: 'x', schedule: { type: 'einmal', at: new Date(t).toISOString() }, delivers: true })
        expect((await a.tick()).lease).toBe(true)
        expect((await b.tick()).lease).toBe(false)
        expect(sent).toHaveLength(1)
    })
})

describe('Planer: Zeitpläne', () => {
    it('täglich 07:30 ist Wiener Zeit, nicht Serverzeit', () => {
        // 2026-10-01 is summer time (UTC+2): 07:30 Vienna = 05:30Z.
        expect(new Date(nextDailySlot(Date.parse('2026-10-01T04:00:00Z'), '07:30', 'Europe/Vienna')).toISOString()).toBe('2026-10-01T05:30:00.000Z')
        expect(new Date(nextDailySlot(Date.parse('2026-10-01T05:30:00Z'), '07:30', 'Europe/Vienna')).toISOString()).toBe('2026-10-02T05:30:00.000Z')
        // Winter time (UTC+1).
        expect(new Date(nextDailySlot(Date.parse('2026-12-01T00:00:00Z'), '07:30', 'Europe/Vienna')).toISOString()).toBe('2026-12-01T06:30:00.000Z')
    })

    it('ein täglicher Job, der weit verpasst wurde, wird als verpasst protokolliert statt spät gemeldet', async () => {
        const { port, sent } = fakePort()
        const planner = make(port)
        const job = planner.upsertSystemJob({ id: 'sys-test-taeglich', kind: 'test', title: 'täglich', schedule: { type: 'taeglich', time: '07:30' }, delivers: true, maxLateMinutes: 60 })
        const slot = Date.parse(job.nextRunAt!)
        t = slot + 5 * 3_600_000
        await planner.tick()
        expect(sent).toHaveLength(0)
        expect(lines(planner.paths.runs)[0]).toMatchObject({ ergebnis: 'verpasst' })
        expect(Date.parse(planner.getJob(job.id)!.nextRunAt!)).toBeGreaterThan(t)
    })

    it('upsertSystemJob ändert die Uhrzeit, ohne den Job zu verdoppeln', () => {
        const planner = make(null)
        planner.upsertSystemJob({ id: 'sys-xy', kind: 'test', title: 'x', schedule: { type: 'taeglich', time: '07:30' }, delivers: true })
        const moved = planner.upsertSystemJob({ id: 'sys-xy', kind: 'test', title: 'x', schedule: { type: 'taeglich', time: '09:00' }, delivers: true })
        expect(planner.listJobs()).toHaveLength(1)
        expect(new Date(moved.nextRunAt!).toISOString()).toBe('2026-10-02T07:00:00.000Z')
    })
})
