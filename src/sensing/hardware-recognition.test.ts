import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hardwareFingerprint, identifyHardware, parseHardwareHypothesis, recognizeHardware, verifyHardwareConnection } from './hardware-recognition.js'
import { loadDevices, markHardwareAsked, recordCandidates, sensingDeviceFingerprint, setDeviceStatus, type DeviceCandidate } from './device-registry.js'
import { approveSensingDevice, declineSensingDevice, hardwareConnectionEvents, unsupportedHardwareEvents, runDiscoveryNow, setSensingConfig, stopSensing } from './runtime.js'
import { environmentAwareness } from './awareness.js'

const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'hardware-')); roots.push(p); return p }
afterEach(() => { stopSensing(); vi.restoreAllMocks(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const interfaces = { eth: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const candidate = (host = '192.168.1.21'): DeviceCandidate => ({ type: 'networkservice', host, port: 80, via: 'tcp', name: 'unknown' })
const shelly = { status: 200, body: JSON.stringify({ id: 'shellyplusplug-s-aabbcc', gen: 2, model: 'SNPL-00112EU' }) }
const guess = (next = 'shelly-info', kind = 'plug') => JSON.stringify({ kind, label: 'Mögliche Steckdose', next })
const owner = { principalId: 'owner-test', permission: 'owner' }

describe('additional fixed manufacturer protocol probes', () => {
    const hue = { status: 200, body: JSON.stringify({ bridgeid: '001788fffe123456', modelid: 'BSB002', swversion: '1967054020' }) }
    const tasmota = { status: 200, body: JSON.stringify({ Status: { Module: 1 }, StatusFWR: { Version: '14.2.0(release-tasmota)' }, StatusNET: { Mac: 'AA:BB:CC:DD:EE:FF' } }) }
    it('confirms public Hue/Tasmota identifiers without guessing devices behind a bridge or firmware', () => {
        expect(identifyHardware(hue, 'hue-config')).toMatchObject({ kind: 'bridge', ecosystem: 'hue', connector: 'hue-readonly' })
        expect(identifyHardware(tasmota, 'tasmota-info')).toMatchObject({ kind: 'unknown', ecosystem: 'tasmota', connector: 'tasmota-readonly' })
        expect(identifyHardware({ status: 401, body: hue.body }, 'hue-config')).toBeNull()
        expect(identifyHardware({ status: 200, body: '{"name":"Hue"}' }, 'hue-config')).toBeNull()
    })
    it('uses public hints only to choose fixed probes, then binds monitoring to the verified identity', async () => {
        for (const [name, response, probe] of [['Hue bridge', hue, 'hue-config'], ['Tasmota', tasmota, 'tasmota-info']] as const) {
            const request = vi.fn(async () => response)
            const [result] = await recognizeHardware([{ ...candidate(), name }], undefined, { interfaces, httpProbe: request })
            expect(result.hardware?.certainty).toBe('confirmed')
            expect(result.hardware?.probe).toBe(probe)
            expect(await verifyHardwareConnection(result, { interfaces, httpProbe: request })).toBe(true)
            expect(await verifyHardwareConnection({ ...result, hardware: { ...result.hardware!, connector: 'shelly-readonly' } }, { interfaces, httpProbe: request })).toBe(false)
        }
    })
    it('offers real read-only monitors and reports Tuya without a pretend executor; rejection is preserved', () => {
        const dir = root()
        const [bridge, tuya, ha] = recordCandidates(dir, [
            { ...candidate(), hardware: identifyHardware(hue, 'hue-config')! },
            { ...candidate('192.168.1.22'), port: 6668, via: 'udp', hardware: { kind: 'unknown', certainty: 'confirmed', label: 'Tuya', identity: '1234567890abcdef', ecosystem: 'tuya', observedAt: new Date().toISOString() } },
            { type: 'homeassistant', host: '192.168.1.23', port: 8123, via: 'http' },
        ])
        const cards = hardwareConnectionEvents(loadDevices(dir))
        expect(cards.find(c => c.subject === bridge.id)?.hint.action.kind).toBe('approveDevice')
        expect(cards.find(c => c.subject === ha.id)?.summary).toContain('tuya')
        expect(cards.some(c => c.subject === tuya.id)).toBe(false)
        expect(unsupportedHardwareEvents(loadDevices(dir))[0].hint.action).toBeUndefined()
        setDeviceStatus(dir, tuya.id, 'abgelehnt', owner)
        expect(unsupportedHardwareEvents(loadDevices(dir))).toEqual([])
    })
    it('binds a Tuya announcement-monitor question to the observed device and rechecks before owner approval', async () => {
        const { parseTuyaAnnouncement } = await import('./tuya-discovery.js')
        const { createCipheriv, createHash } = await import('node:crypto')
        const cipher = createCipheriv('aes-128-ecb', createHash('md5').update('yGAdlopoPVldABfn').digest(), null)
        const payload = Buffer.from(JSON.stringify({ ip: '192.168.1.21', gwId: 'device12345678901234', version: '3.3' }))
        const candidate = parseTuyaAnnouncement(Buffer.concat([cipher.update(payload), cipher.final()]), '192.168.1.21', interfaces)!
        const dir = root(); setSensingConfig({}, {}, dir)
        const [device] = recordCandidates(dir, [candidate])
        const [offer] = hardwareConnectionEvents(loadDevices(dir))
        expect(offer.summary).toContain('Geräteankündigungen beobachten')
        expect(offer.hint.proposal).toContain('kein Schalten')
        expect((await approveSensingDevice(device.id, owner, sensingDeviceFingerprint(device), { interfaces, tuyaBrowse: async () => [] })).ok).toBe(false)
        expect(loadDevices(dir)[0].status).toBe('gefunden')
        const result = await approveSensingDevice(device.id, owner, sensingDeviceFingerprint(device), { interfaces, tuyaBrowse: async () => [candidate] })
        expect(result).toMatchObject({ ok: true })
        expect(result.message).toContain('Kein authentifizierter Direktzugriff')
        expect(loadDevices(dir)[0].status).toBe('eingerichtet')
        const replacement = { ...candidate, hardware: { ...candidate.hardware!, identity: 'other-device-1234' } }
        expect(await verifyHardwareConnection(device, { interfaces, tuyaBrowse: async () => [replacement] })).toBe(false)
    })
})

describe('bounded hardware hypotheses', () => {
    it('verifies a Shelly manufacturer hint even without a model', async () => {
        const probe = vi.fn(async () => shelly)
        const result = await recognizeHardware([{ ...candidate(), name: 'Shelly kitchen' }], undefined, { interfaces, httpProbe: probe })
        expect(result[0].hardware).toMatchObject({ kind: 'plug', certainty: 'confirmed', connector: 'shelly-readonly' })
        expect(probe).toHaveBeenCalledTimes(1)
    })
    it('never overwrites an already protocol-confirmed identity with an LLM guess', async () => {
        const identity = identifyHardware(shelly, 'shelly-info')!
        const model = vi.fn(async () => guess('none', 'tv'))
        const result = await recognizeHardware([{ ...candidate(), hardware: identity }, { ...candidate(), port: 0, type: 'networkdevice', via: 'neighbor' }], model, { interfaces })
        expect(result[0].hardware).toEqual(identity)
        expect(model).not.toHaveBeenCalled()
    })
    it('treats a thrown transport failure as negative evidence and revises the guess', async () => {
        const model = vi.fn().mockResolvedValueOnce(guess()).mockResolvedValueOnce(guess('none', 'unknown'))
        const httpProbe = vi.fn().mockRejectedValue(new Error('connection refused'))
        const result = await recognizeHardware([candidate()], model, { interfaces, httpProbe })
        expect(model).toHaveBeenCalledTimes(2)
        expect(model.mock.calls[1][0]).toContain('unreachable')
        expect(result[0].hardware).toMatchObject({ kind: 'unknown', certainty: 'unknown' })
    })
    it('rejects invalid output and does not accept model URLs, shell or invented connector names', () => {
        expect(parseHardwareHypothesis('run curl')).toBeNull()
        expect(parseHardwareHypothesis('{"kind":"root","label":"x"}')).toBeNull()
        expect(parseHardwareHypothesis(guess('http://169.254.169.254/'))?.next).toBeUndefined()
        expect(parseHardwareHypothesis(guess('toString'))?.next).toBeUndefined()
    })
    it('recognizes Shelly plug from public structured identity, not from a port or label', async () => {
        expect(identifyHardware({ status: 200, body: '{"model":"plug"}' }, 'shelly-info')).toBeNull()
        expect(identifyHardware({ ...shelly, status: 401 }, 'shelly-info')).toBeNull()
        const httpProbe = vi.fn(async () => shelly)
        const result = await recognizeHardware([candidate()], async () => guess(), { interfaces, httpProbe })
        expect(result[0].hardware).toMatchObject({ kind: 'plug', certainty: 'confirmed', manufacturer: 'Shelly', connector: 'shelly-readonly' })
        expect(httpProbe).toHaveBeenCalledWith('http://192.168.1.21:80/rpc/Shelly.GetDeviceInfo', 1200, expect.any(AbortSignal))
    })
    it('revises after contradictory evidence with a different fixed GET probe', async () => {
        const model = vi.fn().mockResolvedValueOnce(guess()).mockResolvedValueOnce(guess('shelly-gen1', 'light'))
        const httpProbe = vi.fn().mockResolvedValueOnce({ status: 404, body: '' }).mockResolvedValueOnce({ status: 200, body: '{"type":"SHBLB-1","mac":"aabbccddeeff"}' })
        const result = await recognizeHardware([candidate()], model, { interfaces, httpProbe })
        expect(model.mock.calls[1][0]).toContain('keine bestätigte Gerätekennung')
        expect(result[0].hardware).toMatchObject({ kind: 'light', model: 'SHBLB-1', certainty: 'confirmed' })
        expect(httpProbe.mock.calls.map(c => c[0])).toEqual(['http://192.168.1.21:80/rpc/Shelly.GetDeviceInfo', 'http://192.168.1.21:80/shelly'])
    })
    it('never promotes repeated guesses or redirect/error results into a connection', async () => {
        const probe = vi.fn(async () => ({ status: 302, body: shelly.body }))
        const result = await recognizeHardware([candidate()], async () => guess(), { interfaces, httpProbe: probe })
        expect(probe).toHaveBeenCalledTimes(1)
        expect(result[0].hardware.certainty).not.toBe('confirmed')
        const dir = root(); recordCandidates(dir, result)
        expect(hardwareConnectionEvents(loadDevices(dir))).toEqual([])
    })
    it('checks scope, limits hosts and does not probe unknown ports', async () => {
        const probe = vi.fn(async () => shelly), model = vi.fn(async () => guess())
        const result = await recognizeHardware([candidate('8.8.8.8'), ...[21, 22, 23, 24, 25].map(n => candidate(`192.168.1.${n}`))], model, { interfaces, httpProbe: probe })
        expect(model).toHaveBeenCalledTimes(3)
        expect(probe).toHaveBeenCalledTimes(3)
        expect(result[0].hardware).toBeUndefined()
        await recognizeHardware([{ ...candidate(), port: 445 }], model, { interfaces, httpProbe: probe })
        expect(probe).toHaveBeenCalledTimes(3)
    })
    it('cancels a hanging model promptly and makes no follow-up connections', async () => {
        const controller = new AbortController(), probe = vi.fn()
        const pending = recognizeHardware([candidate()], () => new Promise(() => {}), { interfaces, httpProbe: probe }, controller.signal)
        controller.abort()
        expect((await pending)[0].hardware).toBeUndefined()
        expect(probe).not.toHaveBeenCalled()
    })
    it('extracts a media renderer without treating XML endpoints as commands or claiming a television panel', () => {
        const xml = '<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><manufacturer>Vendor</manufacturer><modelName>Living room</modelName><UDN>uuid:test</UDN></device>'
        expect(identifyHardware({ status: 200, body: xml }, 'upnp-description')).toMatchObject({ kind: 'tv', certainty: 'confirmed' })
        expect(identifyHardware({ status: 200, body: '<!DOCTYPE x>' + xml }, 'upnp-description')).toBeNull()
    })
})

describe('existing sensing consent and connection paths', () => {
    it('updates evidence but preserves an owner rejection; no new proposal', async () => {
        const dir = root(), h = identifyHardware(shelly, 'shelly-info')!
        const [d] = recordCandidates(dir, [{ ...candidate(), hardware: h }])
        setDeviceStatus(dir, d.id, 'abgelehnt', owner)
        recordCandidates(dir, [{ ...candidate(), hardware: { ...h, label: 'Better label' } }])
        expect(loadDevices(dir)[0]).toMatchObject({ status: 'abgelehnt', hardware: { label: 'Better label' } })
        expect(hardwareConnectionEvents(loadDevices(dir))).toEqual([])
    })
    it('offers a single concrete, identity-bound read-only connection', async () => {
        const dir = root(), h = identifyHardware(shelly, 'shelly-info')!
        const [d] = recordCandidates(dir, [{ ...candidate(), hardware: h }])
        const events = hardwareConnectionEvents(loadDevices(dir))
        expect(events).toHaveLength(1)
        expect(events[0].hint).toMatchObject({ level: 'fragen', action: { kind: 'approveDevice', deviceId: d.id, fingerprint: sensingDeviceFingerprint(d) } })
        expect(events[0].hint.proposal).toContain('Kein Schalten')
        markHardwareAsked(dir, d.id, sensingDeviceFingerprint(d))
        expect(hardwareConnectionEvents(loadDevices(dir))).toEqual([])
        setSensingConfig({}, {}, dir)
        const probe = vi.fn(async () => shelly)
        expect((await approveSensingDevice(d.id, { ...owner, permission: 'user' }, sensingDeviceFingerprint(d), { interfaces, httpProbe: probe })).ok).toBe(false)
        expect(probe).not.toHaveBeenCalled()
        expect((await approveSensingDevice(d.id, owner, sensingDeviceFingerprint(d), { interfaces, httpProbe: probe })).ok).toBe(true)
        expect(loadDevices(dir)[0].status).toBe('eingerichtet')
        expect(probe.mock.calls).toHaveLength(1)
    })
    it('rejects an old approval when the device identity changes, including an old Nein', async () => {
        const dir = root(), h = identifyHardware(shelly, 'shelly-info')!
        const [d] = recordCandidates(dir, [{ ...candidate(), hardware: h }])
        const old = sensingDeviceFingerprint(d)
        recordCandidates(dir, [{ ...candidate(), hardware: { ...h, identity: 'shelly-different' } }])
        setSensingConfig({}, {}, dir)
        const probe = vi.fn(async () => shelly)
        expect((await approveSensingDevice(d.id, owner, old, { interfaces, httpProbe: probe })).ok).toBe(false)
        expect(declineSensingDevice(d.id, owner, old).ok).toBe(false)
        expect(probe).not.toHaveBeenCalled()
        expect(loadDevices(dir)[0].status).toBe('gefunden')
        expect(hardwareFingerprint(h)).not.toBe(hardwareFingerprint({ ...h, identity: 'other' }))
    })
    it('rechecks the actual endpoint and refuses a different occupant or an out-of-scope address', async () => {
        const h = identifyHardware(shelly, 'shelly-info')!
        expect(await verifyHardwareConnection({ ...candidate(), hardware: h }, { interfaces, httpProbe: async () => ({ ...shelly, body: shelly.body.replace('aabbcc', 'ddeeff') }) })).toBe(false)
        const probe = vi.fn(async () => shelly)
        expect(await verifyHardwareConnection({ ...candidate('8.8.8.8'), hardware: h }, { interfaces, httpProbe: probe })).toBe(false)
        expect(probe).not.toHaveBeenCalled()
    })
    it('runs recognition within automatic/manual discovery and persists it without marking connected', async () => {
        const dir = root(); setSensingConfig({ discovery: { mdns: false, maxHosts: 1, deadlineSec: 5, ratePerSec: 200 } }, {}, dir)
        await runDiscoveryNow({ interfaces, neighbors: async () => [], hardwareModel: async () => guess(),
            tcpProbe: async (_, port) => port === 80, httpProbe: async url => url.endsWith('/rpc/Shelly.GetDeviceInfo') ? shelly : { status: 404, body: '' } })
        const d = loadDevices(dir).find(d => d.hardware?.connector === 'shelly-readonly')!
        expect(d).toMatchObject({ status: 'gefunden', hardware: { kind: 'plug', certainty: 'confirmed' }, hardwareAskedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
        const view = environmentAwareness(dir, 'owner')
        expect(view).toContain('Steckdose')
        expect(view).toContain('öffentliche Gerätekennung belegt')
        expect(view).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}:0\b/)
    })
    it('does not offer unsupported devices, mDNS-only HA, configured HA or stale observations', () => {
        const dir = root(); recordCandidates(dir, [{ ...candidate(), hardware: { kind: 'tv', label: 'TV', certainty: 'probable', observedAt: new Date().toISOString() } },
            { type: 'homeassistant', host: '192.168.1.22', port: 8123, via: 'mdns' }])
        expect(hardwareConnectionEvents(loadDevices(dir))).toEqual([])
        const [ha] = recordCandidates(dir, [{ type: 'homeassistant', host: '192.168.1.23', port: 8123, via: 'http' }])
        expect(hardwareConnectionEvents([ha], true)).toEqual([])
        expect(hardwareConnectionEvents([ha], false, Date.now() + 2 * 24 * 60 * 60_000)).toEqual([])
        expect(hardwareConnectionEvents([ha])).toHaveLength(1)
    })

    it('connects the exact approved Home Assistant through the existing login/test flow, not another found instance', async () => {
        const dir = root(); setSensingConfig({}, {}, dir)
        const [ha] = recordCandidates(dir, [{ type: 'homeassistant', host: '192.168.1.23', port: 8123, via: 'http' }])
        const flow = await import('../connections/connect-flow.js')
        const connect = vi.spyOn(flow, 'connectFromApproval').mockResolvedValue({ ok: true, message: 'wartet auf Anmeldung' })
        const result = await approveSensingDevice(ha.id, owner, sensingDeviceFingerprint(ha), { interfaces, httpProbe: async () => ({ status: 200, body: '{"name":"Home Assistant"}' }) })
        expect(result.message).toContain('Anmeldung')
        expect(connect).toHaveBeenCalledWith('home-assistant', owner.principalId, expect.objectContaining({ dataDir: dir }))
        expect(connect.mock.calls[0][2].foundHomeAssistant()).toEqual(['http://192.168.1.23:8123'])
        expect(loadDevices(dir)[0].status).toBe('gefunden')
    })

    it('does not make private model calls when only a Main/cloud LLM is available', async () => {
        const dir = root(); setSensingConfig({ discovery: { mdns: false, maxHosts: 1, deadlineSec: 5, ratePerSec: 200 } }, {}, dir)
        const { getNovaState } = await import('../core/nova-state.js')
        const state = getNovaState(), previous = state.llm, complete = vi.fn()
        state.llm = { complete }
        try {
            await runDiscoveryNow({ interfaces, neighbors: async () => [], tcpProbe: async () => false })
            expect(complete).not.toHaveBeenCalled()
        } finally { state.llm = previous }
    })
})
