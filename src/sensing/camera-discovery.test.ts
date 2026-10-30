import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseOnvifProbeMatch, parseRtspOptions, rtspOptionsRequest, onvifProbeMessage } from './camera-discovery.js'
import { discoverDevices } from './discovery.js'
import { recordCandidates, loadDevices, DEVICE_LABEL } from './device-registry.js'
import { connectDevice, offerDeviceConnections } from './device-connect.js'
import { listApprovalCards } from '../core/approval-cards.js'

// Kameras erkennen (30.10.2026): ONVIF WS-Discovery and RTSP OPTIONS without any login, only targets
// the net-scope gate allows. A camera becomes a device of art Kamera with what is readable without
// login, and a card „Neu gefunden: Kamera …“. No image, no login, no default passwords.
const probeMatch = (xaddr: string, scopes: string) => `<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>${scopes}</d:Scopes><d:XAddrs>${xaddr}</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`
const SCOPES = 'onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/hardware/IPC-HX2431 onvif://www.onvif.org/name/Musterkamera%20Einfahrt onvif://www.onvif.org/mfr/Beispiel'
const interfaces = { eth0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }
const options = { deadlineMs: 2000, ratePerSec: 200, concurrency: 4, maxHosts: 4, mdns: true, tailnetHosts: [] as string[] }
const quiet = { interfaces, neighbors: async () => [], httpProbe: async () => null, tlsProbe: async () => null, mdnsBrowse: async () => [], ssdpBrowse: async () => [], tuyaBrowse: async () => [] }

describe('ONVIF WS-Discovery answer', () => {
    it('reads model and name from the public scopes, bound to the responding address', () => {
        expect(parseOnvifProbeMatch(probeMatch('http://192.168.1.60:8000/onvif/device_service', SCOPES), '192.168.1.60')).toMatchObject({
            host: '192.168.1.60', port: 8000, model: 'IPC-HX2431', name: 'Musterkamera Einfahrt', manufacturer: 'Beispiel' })
    })
    it.each([
        ['address of another host', probeMatch('http://10.0.0.9/onvif/device_service', SCOPES)],
        ['credentials in the address', probeMatch('http://admin:admin@192.168.1.60/onvif/device_service', SCOPES)],
        ['no video device', probeMatch('http://192.168.1.60/onvif/device_service', 'onvif://www.onvif.org/type/printer').replace('NetworkVideoTransmitter', 'Printer')],
        ['not ONVIF at all', '<html>hello</html>'],
        ['oversized answer', probeMatch('http://192.168.1.60/x', SCOPES + ' '.repeat(70_000))],
    ])('ignores %s', (_label, xml) => expect(parseOnvifProbeMatch(xml, '192.168.1.60')).toBeNull())
    it('the probe asks only for video devices and carries nothing but a message id', () => {
        const message = onvifProbeMessage('urn:uuid:00000000-0000-4000-8000-000000000000')
        expect(message).toContain('NetworkVideoTransmitter')
        expect(message).not.toMatch(/password|username|UsernameToken/i)
    })
})

describe('RTSP OPTIONS without login', () => {
    it('the request never carries credentials', () => {
        const request = rtspOptionsRequest('192.168.1.50', 554)
        expect(request).toMatch(/^OPTIONS rtsp:\/\/192\.168\.1\.50:554\/ RTSP\/1\.0\r\n/)
        expect(request).not.toMatch(/authorization|password|admin/i)
    })
    it('reads status and server; anything else is no RTSP', () => {
        expect(parseRtspOptions('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nServer: Beispiel Stream/1.2\r\nWWW-Authenticate: Digest realm="x"\r\n\r\n')).toMatchObject({ status: 401, server: 'Beispiel Stream/1.2', zugang: 'noetig' })
        expect(parseRtspOptions('RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: DESCRIBE, OPTIONS\r\n\r\n')).toMatchObject({ status: 200, zugang: 'offen' })
        expect(parseRtspOptions('HTTP/1.1 400 Bad Request\r\n\r\n')).toBeNull()
        expect(parseRtspOptions('')).toBeNull()
    })
})

describe('camera in the discovery', () => {
    it('open port 554 that answers RTSP becomes a camera; ONVIF finds another one', async () => {
        const report = await discoverDevices(options, { ...quiet,
            tcpProbe: async (host, port) => host === '192.168.1.1' && port === 554,
            rtspProbe: async () => ({ status: 401, server: 'Beispiel Stream/1.2', zugang: 'noetig' }),
            onvifBrowse: async () => [{ host: '192.168.1.2', port: 8000, model: 'IPC-HX2431', manufacturer: 'Beispiel', name: 'Einfahrt' }],
        } as any)
        const cameras = report.candidates.filter(c => c.type === 'camera')
        expect(cameras.map(c => c.host).sort()).toEqual(['192.168.1.1', '192.168.1.2'])
        expect(cameras.find(c => c.host === '192.168.1.1')).toMatchObject({ port: 554, evidence: { server: 'Beispiel Stream/1.2', zugang: 'noetig' } })
        expect(cameras.find(c => c.host === '192.168.1.2')).toMatchObject({ port: 8000, name: 'Einfahrt', evidence: { model: 'IPC-HX2431', manufacturer: 'Beispiel' } })
    })
    it('Gegenprobe: public and foreign ONVIF answers are never used', async () => {
        const report = await discoverDevices(options, { ...quiet, tcpProbe: async () => false, rtspProbe: async () => null,
            onvifBrowse: async () => [{ host: '8.8.8.8', port: 80 }, { host: '192.168.9.9', port: 80 }] } as any)
        expect(report.candidates.filter(c => c.type === 'camera')).toEqual([])
        expect(report.rejected.map(r => r.host)).toEqual(expect.arrayContaining(['8.8.8.8', '192.168.9.9']))
    })
    it('Gegenprobe: a camera that does not answer is no find', async () => {
        const report = await discoverDevices(options, { ...quiet, tcpProbe: async (_host, port) => port === 554, rtspProbe: async () => null, onvifBrowse: async () => [] } as any)
        expect(report.candidates.filter(c => c.type === 'camera')).toEqual([])
        expect(report.candidates.filter(c => c.port === 554).every(c => c.type === 'networkservice')).toBe(true)
    })
    it('never probes RTSP on a target the gate refuses', async () => {
        const asked: string[] = []
        await discoverDevices({ ...options, tailnetHosts: ['8.8.8.8'] }, { ...quiet, tcpProbe: async (host, port) => port === 554,
            rtspProbe: async (host: string) => { asked.push(host); return null }, onvifBrowse: async () => [] } as any)
        expect(asked).not.toContain('8.8.8.8')
    })
})

describe('card for a found camera', () => {
    const owner = { principalId: 'owner', permission: 'owner' }
    it('„Neu gefunden: Kamera …“ says how it would connect; Ja logs in nowhere', async () => {
        expect(DEVICE_LABEL.camera).toBe('Kamera')
        const dataDir = mkdtempSync(join(tmpdir(), 'cam-card-'))
        recordCandidates(dataDir, [{ type: 'camera', host: '192.168.1.60', port: 8000, via: 'udp', name: 'Einfahrt', evidence: { quelle: 'ONVIF', model: 'IPC-HX2431', manufacturer: 'Beispiel' } }])
        const ctx = { eigeneNetze: ['192.168.1.0/24'] }
        const opts = { dataDir }
        expect((await offerDeviceConnections({ dataDir, ctx, cardOpts: opts })).created).toBe(1)
        const [card] = listApprovalCards(opts)
        expect(card.titel).toContain('Neu gefunden: Kamera')
        expect(card.vorschlag).toContain('So würde ich mich verbinden')
        expect(card.vorschlag).toMatch(/Benutzer und Passwort/)
        expect(card.vorschlag).toMatch(/nicht im Chat/)
        expect(JSON.stringify(card)).toContain('IPC-HX2431')
        // Asked once; a second search makes no second card.
        expect((await offerDeviceConnections({ dataDir, ctx, cardOpts: opts })).created).toBe(0)
        const done = await connectDevice({ dataDir, ctx, cardOpts: opts }, loadDevices(dataDir)[0].id, owner)
        expect(done.ok).toBe(true)
        expect(done.message).toMatch(/nichts angemeldet/i)
        expect(done.message).toMatch(/kein Bild/i)
    })
})
