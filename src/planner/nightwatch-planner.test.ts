import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeliveryPort, PlannerOutgoing } from './delivery-port.js'
import { startPlannerRuntime, stopPlannerRuntime } from './runtime.js'

let dir: string
let t: number

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightwatch-planner-'))
    t = Date.parse('2026-10-01T08:00:00.000Z')
})
afterEach(() => {
    stopPlannerRuntime()
    rmSync(dir, { recursive: true, force: true })
})

describe('Nachtwache über den Planer (neuer Weg)', () => {
    it('läuft als Main-Job, schreibt ihr Journal und macht aus Befunden Gedanken mit Meldung', async () => {
        const configPath = join(dir, 'nightwatch.json')
        // Port 9 on loopback is closed: the probe sees "down" without any network beyond 127.0.0.1.
        writeFileSync(configPath, JSON.stringify({
            version: 1, intervalMinutes: 30, hosts: {},
            checks: [{ id: 'dead', label: 'Toter Dienst', kind: 'http', url: 'http://127.0.0.1:9/health', timeoutMs: 2000 }],
        }))
        const sent: PlannerOutgoing[] = []
        const port: DeliveryPort = { name: 'test-port', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }
        let isMain = false
        const handle = await startPlannerRuntime({ planner: { enabled: true, nightwatch: true } }, {
            dataDir: dir, now: () => t, authority: () => isMain, startTimer: false, port,
            nightwatch: { enabled: true, configPath, journalDir: join(dir, 'nightwatch') },
        })
        const job = handle!.planner.getJob('sys-nachtwache')
        expect(job).toMatchObject({ enabled: true, mainOnly: true, schedule: { type: 'intervall', minutes: 30 } })

        await handle!.planner.tick()
        expect(handle!.thoughts.list()).toHaveLength(0)

        isMain = true
        await handle!.planner.tick()
        expect(readdirSync(join(dir, 'nightwatch')).some(name => name.endsWith('.jsonl'))).toBe(true)
        const thoughts = handle!.thoughts.list()
        expect(thoughts).toHaveLength(1)
        expect(thoughts[0]).toMatchObject({ source: 'nachtwache' })
        expect(thoughts[0].title).toContain('Toter Dienst')
        expect(['wichtig', 'dringend']).toContain(thoughts[0].importance)
        // A second tick in the same slot neither probes again nor repeats the notice.
        await handle!.planner.tick()
        expect(sent.filter(msg => msg.kind === 'gedanke')).toHaveLength(1)
    }, 15_000)

    it('bleibt aus, solange autonomy.planner.nightwatch nicht gesetzt ist', async () => {
        const handle = await startPlannerRuntime({ planner: { enabled: true } }, {
            dataDir: dir, now: () => t, authority: () => true, startTimer: false,
            nightwatch: { enabled: true, configPath: join(dir, 'x.json'), journalDir: join(dir, 'nightwatch') },
        })
        expect(handle!.planner.getJob('sys-nachtwache')?.enabled ?? false).toBe(false)
    })
})
