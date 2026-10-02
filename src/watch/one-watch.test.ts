/**
 * 2.82.0 Aufräumen Punkt 2: ein Wächter. L19-Ziele werden übernommen,
 * die Nachtwache läuft nur noch im Wächter (ein Alarm je Ausfall, eine
 * Erholung), der Wächter läuft als Planer-Job und hat keinen Proxmox-Zweig.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createThoughtStore } from '../planner/thoughts.js'
import type { NightwatchReport } from '../doctor/nightwatch.js'
import { createWatchEngine } from './engine.js'
import { parseWatchSettings } from './settings.js'
import { addManagedTarget, loadManagedTargets, migrateLegacyMonitorTargets, removeManagedTarget, targetFromUrl } from './targets.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'one-watch-')); dirs.push(dir); return dir }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const NOON = Date.UTC(2026, 9, 1, 10, 0)

describe('L19-Ziele gehen in den Wächter über (einmal, Datei .migriert)', () => {
    it('übernimmt gültige Ziele, lehnt Zugangsdaten ab, benennt die Datei um und übernimmt nichts doppelt', () => {
        const dir = tmp()
        const legacyFile = join(dir, 'monitoring.json')
        const watchDir = join(dir, 'watch')
        writeFileSync(legacyFile, JSON.stringify({ enabled: true, defaultIntervalMs: 300000, alertAfterFailures: 2, targets: [
            { name: 'Web', url: 'https://example.com/', lastStatus: 'up' },
            { name: 'API', url: 'http://api.example.com:8080/health' },
            { name: 'Geheim', url: 'https://user:pw@example.com/' },
            { name: 'Web', url: 'https://example.com/' },
        ] }))
        const first = migrateLegacyMonitorTargets({ legacyFile, watchDir, now: () => NOON })
        expect(first.migrated).toBe(2)
        expect(first.rejected.join(' ')).toMatch(/Zugangsdaten/)
        expect(existsSync(legacyFile)).toBe(false)
        expect(existsSync(`${legacyFile}.migriert`)).toBe(true)
        const managed = loadManagedTargets(watchDir)
        expect(managed.targets.map(item => [item.name, item.kind, item.host, item.port, item.path, item.origin])).toEqual([
            ['Web', 'https', 'example.com', 443, '/', 'monitor'],
            ['API', 'http', 'api.example.com', 8080, '/health', 'monitor'],
        ])
        expect(managed.migratedFrom).toBe('monitoring.json')
        expect(migrateLegacyMonitorTargets({ legacyFile, watchDir }).reason).toBe('keine L19-Datei')
        expect(loadManagedTargets(watchDir).targets).toHaveLength(2)
    })

    it('/monitor add|remove pflegen dieselbe Liste mit denselben festen Regeln', () => {
        const watchDir = join(tmp(), 'watch')
        expect(typeof addManagedTarget(watchDir, 'NAS', 'https://nas.example.com/')).toBe('object')
        expect(addManagedTarget(watchDir, 'NAS', 'https://nas.example.com/')).toMatch(/schon in der Liste/)
        expect(addManagedTarget(watchDir, 'Vaultwarden', 'https://vault.example.com/')).toMatch(/Passwortmanager/)
        expect(addManagedTarget(watchDir, 'Q', 'https://example.com/?token=x')).toMatch(/Query/)
        expect(targetFromUrl('x', 'ftp://example.com/')).toMatch(/nur http\/https/)
        expect(removeManagedTarget(watchDir, 'nas')).toBe(true)
        expect(loadManagedTargets(watchDir).targets).toEqual([])
    })
})

function nightReport(at: number, status: 'ok' | 'fehler'): NightwatchReport {
    const iso = new Date(at).toISOString()
    return {
        startedAt: iso, finishedAt: iso,
        results: [{ id: 'svc', kind: 'systemd', label: 'Xaventra', host: 'srv', status, severity: 'critical', message: status === 'ok' ? 'active' : 'Dienst failed',
            evidence: { host: 'srv', command: 'systemctl is-active -- x', exitCode: status === 'ok' ? 0 : 3, output: '', durationMs: 5, checkedAt: iso } }] as any,
    }
}

describe('Nachtwache läuft nur im Wächter: ein Alarm je Ausfall, eine Erholung', () => {
    it('Fehler, Fehler, ok → genau ein Alarm-Gedanke, eine Erholung, Alarm erledigt', async () => {
        const dataDir = tmp()
        const clock = { now: NOON }
        const thoughts = createThoughtStore({ dataDir, now: () => clock.now })
        const reports: Array<NightwatchReport | null> = [nightReport(NOON, 'fehler'), null, nightReport(NOON + 30 * 60_000, 'fehler'), nightReport(NOON + 60 * 60_000, 'ok')]
        const engine = createWatchEngine({
            settings: { ...parseWatchSettings({}), enabled: true, includeDevices: false },
            watchDir: join(dataDir, 'watch'), localNodeId: 'main', isMain: () => true,
            collect: async () => ({ schema: 1, nodeId: 'main', at: new Date(clock.now).toISOString(), cpuLoad: 0, ramUsedPct: 10, ramTotalGB: 8, disks: [], tempC: null, services: [], responseMs: 1 }) as any,
            devices: () => [],
            nightwatch: async () => reports.shift() ?? null,
            probes: { tcp: async () => ({ ok: true, ms: 1, detail: '' }), http: async () => ({ ok: true, ms: 1, detail: '' }), ping: async () => ({ ok: true, ms: 1, detail: '' }), tlsValidTo: async () => null, newestMtime: () => null, now: () => clock.now },
            thoughts: { add: input => thoughts.add(input), resolve: id => { thoughts.setStatus(id, 'erledigt', 'waechter') } },
        })
        for (let i = 0; i < 4; i++) { await engine.tick(); clock.now += 5 * 60_000 }
        const list = thoughts.list({ limit: 50 })
        const alarms = list.filter(item => item.title === 'Nachtwache: Xaventra (srv)')
        const recoveries = list.filter(item => /wieder ok/.test(item.title))
        expect(alarms).toHaveLength(1)
        expect(alarms[0]).toMatchObject({ source: 'waechter', importance: 'dringend', status: 'erledigt' })
        expect(alarms[0].evidence).toMatch(/Beleg: "systemctl is-active -- x" → Exit 3/)
        expect(recoveries).toHaveLength(1)
        expect(list.every(item => item.source === 'waechter')).toBe(true)
        const snapshot = JSON.parse(readFileSync(join(dataDir, 'watch', 'snapshot.json'), 'utf8'))
        expect(snapshot.nightwatch).toMatchObject({ total: 1, failing: [] })
    })
})

describe('Verdrahtung', () => {
    const daemon = () => readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')

    it('der Daemon startet den Wächter nach dem Planer; L19 und der Proxmox-Zweig sind weg', () => {
        const source = daemon()
        const planner = source.indexOf('await startPlannerRuntime(autonomyCfg)')
        const watch = source.indexOf("await import('./watch/runtime.js')")
        expect(planner).toBeGreaterThan(0)
        expect(watch).toBeGreaterThan(planner)
        expect(source).not.toMatch(/L19-monitoring|getServiceMonitor/)
        expect(existsSync(fileURLToPath(new URL('../layers/L19-monitoring.ts', import.meta.url)))).toBe(false)
        const runtime = readFileSync(fileURLToPath(new URL('./runtime.ts', import.meta.url)), 'utf8')
        expect(runtime).not.toMatch(/setWatchProxmoxSource|proxmox/i)
    })

    it('mit laufendem Planer ist der Wächter der Planer-Job sys-waechter (kein eigener Timer)', async () => {
        const dataDir = tmp()
        const { startPlannerRuntime, stopPlannerRuntime } = await import('../planner/runtime.js')
        const planner = await startPlannerRuntime({ planner: { enabled: true } }, { dataDir, startTimer: false, authority: () => false })
        try {
            const runtime = await import('./runtime.js')
            runtime.setWatchConfig({ watch: { enabled: true } })
            const started = await runtime.startWatch({ nodeOnly: false })
            expect(started.started).toBe(true)
            expect(started.reason).toMatch(/^Planer alle 5 min/)
            expect(runtime.watchRunningVia()).toBe('Planer')
            expect(planner!.planner.getJob('sys-waechter')).toMatchObject({ kind: 'waechter', mainOnly: true, enabled: true })
            runtime.stopWatch()
        } finally { stopPlannerRuntime() }
    })

    it('ein alter Planer-Job sys-nachtwache wird abgeschaltet, nie doppelt ausgeführt', async () => {
        const dataDir = tmp()
        const { startPlannerRuntime, stopPlannerRuntime, SYSTEM_JOB_IDS } = await import('../planner/runtime.js')
        const first = await startPlannerRuntime({ planner: { enabled: true } }, { dataDir, startTimer: false, authority: () => false })
        first!.planner.upsertSystemJob({ id: SYSTEM_JOB_IDS.nachtwache, kind: 'nachtwache', title: 'Nachtwache', schedule: { type: 'intervall', minutes: 30 }, mainOnly: true, enabled: true })
        stopPlannerRuntime()
        const second = await startPlannerRuntime({ planner: { enabled: true, nightwatch: true }, nightwatch: { enabled: true } }, { dataDir, startTimer: false, authority: () => false })
        try {
            expect(second!.planner.getJob(SYSTEM_JOB_IDS.nachtwache)?.enabled).toBe(false)
        } finally { stopPlannerRuntime() }
    })
})
