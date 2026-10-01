/**
 * 2.82.0 Aufräumen Punkt 4: eine Schwellen-Definition für Platte/RAM.
 * L0, L21, node-profile, Nachtwache, Selbstheilung und Wächter lesen
 * core/resource-thresholds.ts — keine eigenen Zahlen mehr.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESOURCE_THRESHOLDS, diskLevel, getResourceThresholds, memoryLevel, parseResourceThresholds, setResourceThresholds } from './resource-thresholds.js'
import { runCheck, type CommandOutcome } from '../doctor/nightwatch-checks.js'
import { runLocalSelfCheck } from './node-profile.js'
import { parseSelfHealSettings } from '../doctor/self-heal.js'
import { ramForecasts } from '../watch/trends.js'

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
const df = (pct: number): CommandOutcome => ({ exitCode: 0, timedOut: false, stderr: '', stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 ${pct} ${100 - pct} ${pct}% /\n` })

afterEach(() => { setResourceThresholds(undefined) })

describe('eine Schwellen-Definition (Platte/RAM)', () => {
    it('defaults: Platte 90/95 % und 5 GB frei, RAM 90/95 %', () => {
        expect(parseResourceThresholds(undefined)).toEqual({ disk: { warnPercent: 90, critPercent: 95, minFreeGB: 5 }, memory: { warnPercent: 90, critPercent: 95 } })
        expect(diskLevel(89, 100)).toBe('ok')
        expect(diskLevel(90, 100)).toBe('warn')
        expect(diskLevel(95, 100)).toBe('crit')
        expect(diskLevel(50, 4)).toBe('warn')
        expect(memoryLevel(89)).toBe('ok')
        expect(memoryLevel(92)).toBe('warn')
        expect(memoryLevel(96)).toBe('crit')
    })

    it('config autonomy.thresholds overrides; warn never above crit; garbage falls back', () => {
        const t = setResourceThresholds({ thresholds: { disk: { warnPercent: 80, critPercent: 88, minFreeGB: 0 }, memory: { warnPercent: 99, critPercent: 97 } } })
        expect(t.disk).toEqual({ warnPercent: 80, critPercent: 88, minFreeGB: 0 })
        expect(t.memory).toEqual({ warnPercent: 97, critPercent: 97 })
        expect(getResourceThresholds()).toBe(t)
        expect(parseResourceThresholds({ disk: { warnPercent: 'x', critPercent: 400 } }).disk).toEqual(DEFAULT_RESOURCE_THRESHOLDS.disk)
    })

    it('Nachtwache ohne eigene Schwelle folgt der einen Definition (85 % ist kein Befund mehr)', async () => {
        const check = { id: 'd', kind: 'disk' as const, mount: '/' }
        expect((await runCheck(check, { local: { kind: 'local' } }, { runner: vi.fn(async () => df(85)) })).status).toBe('ok')
        setResourceThresholds({ thresholds: { disk: { warnPercent: 80, critPercent: 84 } } })
        expect(await runCheck(check, { local: { kind: 'local' } }, { runner: vi.fn(async () => df(85)) })).toMatchObject({ status: 'fehler', severity: 'critical' })
        // an explicit per-check value still wins
        expect((await runCheck({ ...check, warnPercent: 86, critPercent: 99 }, { local: { kind: 'local' } }, { runner: vi.fn(async () => df(85)) })).status).toBe('ok')
    })

    it('node-profile-Selbstprüfung und Selbstheilung lesen dieselben Zahlen', () => {
        setResourceThresholds({ thresholds: { disk: { warnPercent: 0.5, critPercent: 1 } } })
        const check = runLocalSelfCheck(process.cwd())
        expect(check.items.find(item => item.id === 'disk-root')?.status).toBe('crit')
        setResourceThresholds({ thresholds: { disk: { warnPercent: 77 } } })
        expect(parseSelfHealSettings(undefined).diskPercent).toBe(77)
    })

    it('Wächter-RAM-Prognose endet an memory.critPercent', () => {
        setResourceThresholds({ thresholds: { memory: { critPercent: 80 } } })
        const now = Date.parse('2026-10-01T12:00:00Z')
        const samples = Array.from({ length: 8 }, (_, i) => ({ nodeId: 'n1', at: new Date(now - (7 - i) * 12 * 3_600_000).toISOString(), ramUsedPct: 60 + i * 2, disks: [], cpuLoad: null, tempC: null, responseMs: null, services: [] }))
        const [forecast] = ramForecasts(samples as any, now)
        expect(forecast?.limit).toBe(80)
    })

    it('keine eigenen Platten-/RAM-Zahlen mehr in den Verbrauchern', () => {
        expect(src('layers/L0-health-monitor.ts')).not.toMatch(/diskUsedMaxPercent|memoryMaxPercent|diskFreeMinMB/)
        expect(src('layers/L21-node-health.ts')).not.toMatch(/diskUsedPercent:\s*\d|memoryUsedPercent:\s*\d/)
        expect(src('core/node-profile.ts')).not.toMatch(/usageStatus\(used, 85, 95\)|memoryFree < 5/)
        expect(src('doctor/nightwatch-checks.ts')).not.toMatch(/\?\? 85|\?\? 95/)
        for (const file of ['layers/L0-health-monitor.ts', 'layers/L21-node-health.ts', 'core/node-profile.ts', 'doctor/nightwatch-checks.ts', 'watch/trends.ts', 'doctor/self-heal.ts']) {
            expect(src(file), file).toMatch(/resource-thresholds\.js/)
        }
    })
})
