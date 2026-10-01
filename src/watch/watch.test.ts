import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createThoughtStore, deliverPendingThoughts } from '../planner/thoughts.js'
import { createWatchEngine, debounce, resolveWatchTargets, type WatchEngineDeps } from './engine.js'
import { acceptPeerWatchSample } from './peer.js'
import type { WatchProbeDeps } from './probes.js'
import type { WatchSample } from './sample.js'
import { parseWatchSettings, type WatchTarget } from './settings.js'
import { targetFromUrl } from './targets.js'
import { appendWatchSample, maintainWatchStore, readWatchSamples, samplesDir } from './store.js'
import { DAY_MS, diskForecasts, forecastToLimit, linearRegression } from './trends.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'waechter-')); dirs.push(dir); return dir }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

// 2026-10-01 23:30 Europe/Vienna (CEST) = 21:30 UTC → inside the default quiet hours 22–7.
const NIGHT = Date.UTC(2026, 9, 1, 21, 30)
// 2026-10-01 12:00 Vienna.
const NOON = Date.UTC(2026, 9, 1, 10, 0)

function sample(nodeId: string, at: number, usedPct = 50, ramUsedPct = 40): WatchSample {
    return { schema: 1, nodeId, at: new Date(at).toISOString(), cpuLoad: 0.2, ramUsedPct, ramTotalGB: 16, disks: [{ mount: '/', usedPct, totalGB: 100, freeGB: 100 - usedPct }], tempC: null, services: [], responseMs: 1 }
}

function fakeProbes(clock: { now: number }, overrides: Partial<WatchProbeDeps> = {}) {
    const calls: string[] = []
    const deps: WatchProbeDeps = {
        async tcp(host, port) { calls.push(`tcp ${host}:${port}`); return { ok: true, ms: 3, detail: 'verbunden' } },
        async http(url) { calls.push(`http ${url}`); return { ok: true, ms: 5, detail: 'HTTP 200' } },
        async ping(host) { calls.push(`ping ${host}`); return { ok: true, ms: 1, detail: 'Antwort' } },
        async tlsValidTo(host, port) { calls.push(`tls ${host}:${port}`); return clock.now + 90 * DAY_MS },
        newestMtime(path) { calls.push(`stat ${path}`); return clock.now - 3_600_000 },
        now: () => clock.now,
        ...overrides,
    }
    return { deps, calls }
}

function engineFor(options: { autonomy: any; clock: { now: number }; ownUsedPct?: number; probes?: Partial<WatchProbeDeps>; devices?: WatchEngineDeps['devices']; managedTargets?: WatchEngineDeps['managedTargets']; nightwatch?: WatchEngineDeps['nightwatch']; main?: boolean }) {
    const dataDir = tmp()
    const watchDir = join(dataDir, 'watch')
    const thoughts = createThoughtStore({ dataDir, now: () => options.clock.now })
    const { deps, calls } = fakeProbes(options.clock, options.probes)
    const resolved: string[] = []
    const l1: string[] = []
    const engine = createWatchEngine({
        settings: parseWatchSettings(options.autonomy),
        watchDir,
        localNodeId: 'spark',
        isMain: () => options.main !== false,
        collect: async () => sample('spark', options.clock.now, options.ownUsedPct ?? 50),
        devices: options.devices ?? (() => []),
        managedTargets: options.managedTargets,
        nightwatch: options.nightwatch,
        probes: deps,
        thoughts: { add: input => thoughts.add(input), resolve: id => { resolved.push(id); thoughts.setStatus(id, 'erledigt', 'waechter') } },
        runL1: async action => { l1.push(action.kind); return { ok: true, message: 'ok' } },
    })
    return { engine, thoughts, calls, resolved, l1, watchDir, dataDir }
}

describe('Wächter: Messverlauf (Aufbewahrung 30 Tage, Größe)', () => {
    it('drops days older than 30 days, keeps day 30, compacts finished days', () => {
        const dir = tmp()
        const now = NOON
        for (const age of [0, 1, 29, 30, 45]) {
            appendWatchSample(dir, sample('spark', now - age * DAY_MS), 10 * 1024 * 1024)
            appendWatchSample(dir, sample('spark', now - age * DAY_MS + 60_000), 10 * 1024 * 1024)
        }
        const result = maintainWatchStore(dir, { retentionDays: 30, maxBytes: 10 * 1024 * 1024, now })
        const day = (age: number) => new Date(now - age * DAY_MS).toISOString().slice(0, 10)
        expect(result.removed.sort()).toEqual([`${day(45)}.jsonl`, `${day(30)}.jsonl`].sort())
        const files = readdirSync(samplesDir(dir)).sort()
        expect(files).toEqual([`${day(29)}.h.jsonl`, `${day(1)}.h.jsonl`, `${day(0)}.jsonl`].sort())
        // Two raw samples in one hour became one hourly mean with weight 2.
        const compacted = readWatchSamples(dir, { sinceMs: now - 2 * DAY_MS }).filter(item => item.agg)
        expect(compacted).toHaveLength(1)
        expect(compacted[0].agg).toEqual({ n: 2 })
    })

    it('enforces the size limit, oldest first, never today', () => {
        const dir = tmp()
        const now = NOON
        for (let age = 0; age < 10; age++) for (let i = 0; i < 40; i++) appendWatchSample(dir, sample(`node-${i}`, now - age * DAY_MS), 50 * 1024 * 1024)
        const before = readdirSync(samplesDir(dir)).length
        const result = maintainWatchStore(dir, { retentionDays: 30, maxBytes: 12_000, now })
        expect(result.bytes).toBeLessThanOrEqual(12_000)
        const left = readdirSync(samplesDir(dir)).sort()
        expect(left.length).toBeLessThan(before)
        expect(left).toContain(`${new Date(now).toISOString().slice(0, 10)}.jsonl`)
        // What is left is the newest days.
        expect(left[0] >= new Date(now - 5 * DAY_MS).toISOString().slice(0, 10)).toBe(true)
    })

    it('refuses to append once today alone reaches a quarter of the limit', () => {
        const dir = tmp()
        let accepted = 0
        for (let i = 0; i < 50; i++) if (appendWatchSample(dir, sample('spark', NOON + i), 4000)) accepted++
        expect(accepted).toBeGreaterThan(0)
        expect(accepted).toBeLessThan(50)
    })
})

describe('Wächter: Prognose „Platte voll in X Tagen“', () => {
    it('linear regression recovers slope and intercept', () => {
        const fit = linearRegression([[0, 1], [1, 3], [2, 5], [3, 7]])!
        expect(fit.slope).toBeCloseTo(2)
        expect(fit.intercept).toBeCloseTo(1)
    })

    it('reports a disk growing 2 %-points per day from 80 % as full in about 10 days', () => {
        const now = NOON
        const samples = Array.from({ length: 7 * 24 }, (_, hour) => sample('ns1', now - (7 * 24 - 1 - hour) * 3_600_000, 80 - (7 * 24 - 1 - hour) / 12))
        const [forecast] = diskForecasts(samples, now)
        expect(forecast.nodeId).toBe('ns1')
        expect(forecast.subject).toBe('/')
        expect(forecast.perDay).toBeCloseTo(2, 1)
        expect(forecast.daysLeft).toBeCloseTo(10, 0)
    })

    it('stays silent for a flat disk, a slow disk (> 14 days) and too little data', () => {
        const now = NOON
        const series = (perDay: number) => Array.from({ length: 48 }, (_, i) => sample('ns2', now - (47 - i) * 3_600_000, 50 + perDay * (i - 47) / 24))
        expect(diskForecasts(series(0), now)).toEqual([])
        expect(diskForecasts(series(1), now)).toEqual([]) // 50 % left at 1 %/day = 50 days
        expect(forecastToLimit([[now - 3_600_000, 90], [now, 95]], 100, now)).toBeNull()
    })
})

describe('Wächter: TLS-Zertifikate', () => {
    it('reports < 21 days as wichtig, < 7 days as dringend, 90 days not at all', async () => {
        const clock = { now: NOON }
        for (const [days, expected] of [[90, null], [10, 'wichtig'], [3, 'dringend']] as const) {
            const { engine, thoughts } = engineFor({ autonomy: { watch: { enabled: true, tls: [{ name: 'Webseite', host: 'example.com' }] } }, clock, probes: { tlsValidTo: async () => clock.now + days * DAY_MS } })
            await engine.tick()
            const tls = thoughts.list().filter(item => item.title.includes('TLS'))
            if (expected === null) expect(tls).toEqual([])
            else {
                expect(tls).toHaveLength(1)
                expect(tls[0].importance).toBe(expected)
                expect(tls[0].title).toContain(`${days} Tagen`)
            }
        }
    })
})

describe('Wächter: Entprellen und Erholung', () => {
    it('alarms only after 3 failures in a row, once, and reports the recovery once', async () => {
        const clock = { now: NOON }
        let up = false
        const { engine, thoughts, resolved } = engineFor({
            autonomy: { watch: { enabled: true, failThreshold: 3, targets: [{ name: 'Drucker', host: 'example.com', kind: 'tcp', port: 7125 }] } },
            clock, probes: { tcp: async () => up ? { ok: true, ms: 4, detail: 'verbunden' } : { ok: false, ms: null, detail: 'ECONNREFUSED' } },
        })
        const down = () => thoughts.list().filter(item => item.title.includes('nicht erreichbar'))
        await engine.tick(); clock.now += 300_000
        await engine.tick(); clock.now += 300_000
        expect(down()).toEqual([])
        await engine.tick(); clock.now += 300_000
        expect(down()).toHaveLength(1)
        await engine.tick(); clock.now += 300_000
        expect(down()).toHaveLength(1)
        expect(down()[0].seen).toBe(1)
        up = true
        await engine.tick(); clock.now += 300_000
        await engine.tick()
        const back = thoughts.list().filter(item => item.title.includes('wieder erreichbar'))
        expect(back).toHaveLength(1)
        expect(resolved).toEqual([down()[0].id])
        expect(down()[0].status).toBe('erledigt')
    })

    it('a single blip never alarms', () => {
        let state = debounce(undefined, false, 3, 'a').state
        state = debounce(state, true, 3, 'b').state
        state = debounce(state, false, 3, 'c').state
        const step = debounce(state, false, 3, 'd')
        expect(step.event).toBeNull()
        expect(debounce(step.state, false, 3, 'e').event).toBe('alarm')
    })
})

describe('Wächter: nur Ziele aus der Liste', () => {
    it('probes exactly the configured, own (/monitor, migrated L19) and set-up targets — nothing else, no ranges, no password manager', async () => {
        const clock = { now: NOON }
        const { engine, calls } = engineFor({
            autonomy: { watch: { enabled: true, targets: [
                { name: 'Web', host: 'example.com', kind: 'https' },
                { name: 'SSH', host: 'example.com', kind: 'tcp', port: 22 },
                { name: 'Bereich', host: 'example.com', kind: 'tcp', port: '1-1024' },
                { name: 'Vaultwarden', host: 'vault.example.com', kind: 'https' },
                { name: 'Mit Login', host: 'user:pw@example.com', kind: 'http' },
                { name: 'Netz', host: '192.168.1.0/24', kind: 'ping' },
                { name: 'Shell', host: '-oProxyCommand=x', kind: 'ping' },
            ] } },
            clock,
            devices: () => [{ name: 'Drucker', host: 'printer.example.com', port: 7125 }],
            managedTargets: () => [targetFromUrl('Labor', 'http://labor.example.com/health') as WatchTarget],
        })
        const result = await engine.tick()
        expect(result.targets).toBe(4)
        expect(calls.sort()).toEqual([
            'http http://labor.example.com:80/health',
            'http https://example.com:443/',
            'tcp example.com:22',
            'tcp printer.example.com:7125',
        ])
    })

    it('reports refused entries instead of silently ignoring them', () => {
        const settings = parseWatchSettings({ watch: { targets: [{ name: 'Passwortmanager', host: 'pw.example.com', kind: 'https' }, { host: 'example.com', kind: 'smtp' }] } })
        expect(settings.targets).toEqual([])
        expect(settings.rejected.join(' ')).toMatch(/Passwortmanager wird nie übernommen/)
        expect(settings.rejected.join(' ')).toMatch(/unbekannte Art/)
        expect(resolveWatchTargets({ ...settings, includeDevices: false }, [{ name: 'x', host: 'printer.example.com', port: 1 }]).targets).toEqual([])
        // Proxmox guests are not a Wächter target source any more (no double alarm with the Proxmox sensing adapter).
        expect(parseWatchSettings({ watch: { includeProxmox: true } })).not.toHaveProperty('includeProxmox')
    })
})

describe('Wächter: Ruhezeit und Dedupe', () => {
    it('holds a warning during quiet hours, lets a critical through, and dedupes a repeating forecast', async () => {
        const clock = { now: NIGHT }
        const { engine, thoughts, l1, watchDir } = engineFor({
            ownUsedPct: 90,
            autonomy: { watch: { enabled: true, tls: [{ name: 'Webseite', host: 'example.com' }], backups: [{ name: 'NAS-Backup', path: '/backup', maxAgeHours: 26 }] } },
            clock,
            probes: { tlsValidTo: async () => clock.now + 2 * DAY_MS, newestMtime: () => clock.now - 30 * 3_600_000 },
        })
        // Seven days of the own root disk filling up 3 %-points per day.
        for (let hour = 7 * 24; hour >= 1; hour--) appendWatchSample(watchDir, sample('spark', clock.now - hour * 3_600_000, 90 - hour / 8), 10 * 1024 * 1024)
        await engine.tick()
        clock.now += 300_000
        await engine.tick()
        const disk = thoughts.list().filter(item => item.title.startsWith('Platte'))
        expect(disk).toHaveLength(1)
        expect(disk[0].seen).toBe(2)
        // L1 on the own node ran exactly once (new alarm), not on the repeat.
        expect(l1).toEqual(['self-heal-zyklus'])
        const sent: string[] = []
        const outcome = await deliverPendingThoughts(thoughts, { name: 'test', deliver: async msg => { sent.push(msg.title); return { status: 'zugestellt' } } }, { now: clock.now, briefingEnabled: true })
        expect(sent.some(title => title.includes('TLS'))).toBe(true) // dringend: 2 days
        expect(sent.some(title => title.startsWith('Backup'))).toBe(false) // wichtig: held at night
        expect(outcome.held).toBeGreaterThan(0)
    })
})

describe('Wächter: Worker-Werte nur von signierten bekannten Knoten', () => {
    const ctx = (dir: string, overrides: Partial<Parameters<typeof acceptPeerWatchSample>[1]> = {}) => ({ enabled: true, isMain: true, watchDir: dir, maxBytes: 1024 * 1024, now: NOON, lastAccepted: new Map<string, number>(), ...overrides })

    it('stores a sample of a configured peer with key, bound to the sender', () => {
        const dir = tmp()
        const result = acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON), knownNodes: ['ns1', 'nas'], localNodeId: 'spark' }, ctx(dir))
        expect(result).toEqual({ accepted: true, reason: 'gespeichert' })
        expect(readWatchSamples(dir).map(item => item.nodeId)).toEqual(['ns1'])
    })

    it('rejects unknown nodes, foreign node ids, floods, off and non-Main', () => {
        const dir = tmp()
        const known = ['ns1']
        expect(acceptPeerWatchSample({ sourceNode: 'fremd', payload: sample('fremd', NOON), knownNodes: known, localNodeId: 'spark' }, ctx(dir)).accepted).toBe(false)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns2', NOON), knownNodes: known, localNodeId: 'spark' }, ctx(dir)).reason).toMatch(/anderen Knoten/)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON), knownNodes: known, localNodeId: 'spark' }, ctx(dir, { enabled: false })).accepted).toBe(false)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON), knownNodes: known, localNodeId: 'spark' }, ctx(dir, { isMain: false })).accepted).toBe(false)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON + 3 * DAY_MS), knownNodes: known, localNodeId: 'spark' }, ctx(dir)).reason).toMatch(/Zeitstempel/)
        const shared = ctx(dir)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON), knownNodes: known, localNodeId: 'spark' }, shared).accepted).toBe(true)
        expect(acceptPeerWatchSample({ sourceNode: 'ns1', payload: sample('ns1', NOON), knownNodes: known, localNodeId: 'spark' }, { ...shared, now: NOON + 10_000 }).reason).toBe('zu häufig')
        expect(readWatchSamples(dir)).toHaveLength(1)
    })

    it('only peers with a pinned publicKey count as known', async () => {
        const { watchKnownNodes } = await import('../mesh/mesh-transport-runtime.js')
        expect(watchKnownNodes([
            { nodeId: 'ns1', transport: 'direct', status: 'unknown', publicKey: 'MCowBQYDK2VwAyEA' },
            { nodeId: 'tofu', transport: 'direct', status: 'unknown' },
            { nodeId: 'leer', transport: 'direct', status: 'unknown', publicKey: '  ' },
        ] as any)).toEqual(['ns1'])
    })
})

describe('Wächter: aus = nichts läuft', () => {
    it('the engine neither measures, probes, stores nor thinks when off', async () => {
        const clock = { now: NOON }
        const { engine, calls, thoughts, watchDir } = engineFor({ autonomy: { watch: { enabled: false, targets: [{ name: 'Web', host: 'example.com', kind: 'https' }], tls: [{ host: 'example.com' }] } }, clock })
        const result = await engine.tick()
        expect(result.active).toBe(false)
        expect(calls).toEqual([])
        expect(existsSync(watchDir)).toBe(false)
        expect(thoughts.list()).toEqual([])
    })

    it('a worker (no authority) does not probe either', async () => {
        const clock = { now: NOON }
        const { engine, calls } = engineFor({ autonomy: { watch: { enabled: true, targets: [{ name: 'Web', host: 'example.com', kind: 'https' }] } }, clock, main: false })
        expect((await engine.tick()).active).toBe(false)
        expect(calls).toEqual([])
    })

    it('runtime: default config is off, start refuses, no mesh sample is measured', async () => {
        const runtime = await import('./runtime.js')
        expect(runtime.setWatchConfig(undefined).enabled).toBe(false)
        const start = await runtime.startWatch({ nodeOnly: false })
        expect(start.started).toBe(false)
        expect(start.reason).toMatch(/nichts zu bewachen/)
        expect(await runtime.watchSampleForMesh()).toBeNull()
        expect((await runtime.ingestPeerWatchSample('ns1', sample('ns1', Date.now()), ['ns1'])).accepted).toBe(false)
    })
})

describe('Wächter: Übersicht', () => {
    it('formats /waechter for the owner only and gives compact /status lines', async () => {
        const { buildWatchOverview, formatWaechter, formatWatchStatusLines } = await import('./engine.js')
        const clock = { now: NOON }
        const { engine, watchDir } = engineFor({ autonomy: { watch: { enabled: true, targets: [{ name: 'Web', host: 'example.com', kind: 'https' }] } }, clock })
        await engine.tick()
        const overview = buildWatchOverview(parseWatchSettings({ watch: { enabled: true } }), watchDir, clock.now)
        expect(overview.nodes.map(node => node.nodeId)).toEqual(['spark'])
        expect(formatWaechter(overview, { permission: 'user' })).toMatch(/nur für den Owner/)
        expect(formatWaechter(overview, { permission: 'owner' })).toMatch(/Erreichbarkeit\* \(1\/1 ok/)
        expect(formatWatchStatusLines(overview)[0]).toMatch(/1 Knoten, 1\/1 Ziele ok/)
    })
})
