import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSensingConfig, startSensing, stopSensing, ingestScoutReport } from './runtime.js'
import { loadDevices } from './device-registry.js'

// Späher (30.10.2026): a mesh worker searches its own networks only when the operator set
// autonomy.sensing.scout=true on that node (default off). Main records the findings with
// the scout's name; the gate keeps public/foreign addresses out.
afterEach(() => { stopSensing(); vi.useRealTimers() })

describe('scout switch on a mesh worker', () => {
    it('a worker without the switch does not search (unchanged)', () => {
        setSensingConfig({ enabled: true, discovery: { enabled: true } }, {}, mkdtempSync(join(tmpdir(), 'scout-off-')))
        expect(startSensing({ nodeOnly: true })).toMatchObject({ started: false })
    })
    it('a worker with scout=true runs only the discovery and reports it', async () => {
        vi.useFakeTimers()
        const runner = vi.fn(async () => undefined)
        setSensingConfig({ enabled: true, scout: true, discovery: { enabled: true, firstRunDelaySec: 1 } }, {}, mkdtempSync(join(tmpdir(), 'scout-on-')))
        const result = startSensing({ nodeOnly: true, scoutRunner: runner })
        expect(result).toMatchObject({ started: true })
        expect(result.reason).toMatch(/Späher/)
        await vi.advanceTimersByTimeAsync(1500)
        expect(runner).toHaveBeenCalledOnce()
    })
    it('scout is never on by default, also not via "enabled"', () => {
        setSensingConfig({ enabled: true, scout: 'true' }, {}, mkdtempSync(join(tmpdir(), 'scout-str-')))
        expect(startSensing({ nodeOnly: true, scoutRunner: async () => undefined })).toMatchObject({ started: false })
    })
})

describe('Main takes over a scout report', () => {
    it('records accepted devices with the scout name, drops public/foreign ones', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'scout-main-'))
        setSensingConfig({ enabled: true }, {}, dataDir)
        const result = await ingestScoutReport('xaventra-nas', {
            subnets: ['192.168.1.0/24'], hasTailnet: false,
            candidates: [
                { type: 'homeassistant', host: '192.168.1.20', port: 8123, via: 'http', name: 'Home Assistant' },
                { type: 'networkdevice', host: '8.8.8.8', port: 443, via: 'tcp' },
            ],
        }, { offerCards: false })
        expect(result).toMatchObject({ recorded: 1, rejected: 1 })
        const devices = loadDevices(dataDir)
        expect(devices.map(d => d.host)).toEqual(['192.168.1.20'])
        expect(devices[0].seenBy).toBe('xaventra-nas')
    })
    it('keeps what a scout read about a camera (type and evidence)', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'scout-cam-'))
        setSensingConfig({ enabled: true }, {}, dataDir)
        await ingestScoutReport('xaventra-nas', { subnets: ['192.168.1.0/24'], hasTailnet: false,
            candidates: [{ type: 'camera', host: '192.168.1.60', port: 8000, via: 'udp', name: 'Einfahrt', evidence: { quelle: 'ONVIF', model: 'IPC-HX2431' } }] }, { offerCards: false })
        expect(loadDevices(dataDir)[0]).toMatchObject({ type: 'camera', seenBy: 'xaventra-nas', status: 'gefunden', evidence: { model: 'IPC-HX2431' } })
    })
})
