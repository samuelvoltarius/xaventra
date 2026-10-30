import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSensingConfig } from './config.js'
import { setSensingConfig, startSensing, stopSensing } from './runtime.js'

// 2.91.2 (NAS rollout 30.10.): on a worker every autonomy switch is "missing = off" (defaultOn), so
// `autonomy.sensing.scout: true` alone started nothing - silently (enabled and discovery.enabled both off).
// scout:true on a worker implies both unless they are explicitly false, with gentle worker defaults; a scout that
// still does not start says why in one log line.
const WORKER = { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv
afterEach(() => { stopSensing(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('scout: true alone makes a worker a scout', () => {
    it('implies enabled and discovery.enabled with gentle worker defaults', () => {
        const cfg = parseSensingConfig({ scout: true }, WORKER)
        expect(cfg.enabled).toBe(true)
        expect(cfg.discovery.enabled).toBe(true)
        expect(cfg.discovery).toMatchObject({ firstRunDelaySec: 300, intervalHours: 6, ratePerSec: 10, concurrency: 4 })
    })

    it('explicit values win; without scout the worker stays off as before', () => {
        expect(parseSensingConfig({ scout: true, discovery: { intervalHours: 2, ratePerSec: 20 } }, WORKER).discovery).toMatchObject({ intervalHours: 2, ratePerSec: 20 })
        const off = parseSensingConfig({}, WORKER)
        expect(off.enabled).toBe(false)
        expect(off.discovery.enabled).toBe(false)
    })

    it('starts the scout on a worker from scout: true alone', async () => {
        vi.stubEnv('NOVA_NODE_ONLY', 'true')
        vi.useFakeTimers()
        const runner = vi.fn(async () => undefined)
        setSensingConfig({ scout: true }, {}, mkdtempSync(join(tmpdir(), 'scout-alone-')))
        expect(startSensing({ nodeOnly: true, scoutRunner: runner })).toMatchObject({ started: true })
    })

    it('counter-test: scout with discovery.enabled false stays off and says why in the log', () => {
        vi.stubEnv('NOVA_NODE_ONLY', 'true')
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        setSensingConfig({ scout: true, discovery: { enabled: false } }, {}, mkdtempSync(join(tmpdir(), 'scout-off-')))
        const result = startSensing({ nodeOnly: true, scoutRunner: async () => undefined })
        expect(result.started).toBe(false)
        expect(result.reason).toMatch(/discovery\.enabled/)
        expect(log.mock.calls.map(call => call.join(' ')).join('\n')).toMatch(/Späher.*startet nicht.*discovery\.enabled/s)
    })
})
