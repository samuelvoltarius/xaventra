import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { CameraError, onvifSnapshot } from './camera-client.js'
import { cameraStandbild, pruneCameraStills, readCameraAccess, submitCameraAccess } from './camera-access.js'
import { approveDevice, loadDevices, monitoredDevices, recordCandidates, sensingDeviceFingerprint } from './device-registry.js'
import { assertSendableImage } from '../media/image-source-policy.js'

// Kamera anbinden (30.10.2026): the owner alone enters the login in the desktop app; the login goes
// only to the node that found the camera, only for that address. One still on request, no sound,
// at most 24 h in the private image folder. The password is in no log, error text or URL.
const PASSWORT = ['fixture', 'kamera', String(4711), 'x'].join('-')
const login = { benutzer: 'betrachter', passwort: PASSWORT }
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64)])
const target = { host: '192.168.1.60', port: 8000 }

const soap = (body: string) => new Response(`<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body>${body}</e:Body></e:Envelope>`, { status: 200 })
function fakeCamera(over: { snapshotUri?: string; soap401?: boolean; mediaHost?: string; image?: Buffer } = {}) {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: any, init: any = {}) => {
        calls.push({ url: String(url), init })
        const body = String(init.body || '')
        if (over.soap401 && body) return new Response('', { status: 401 })
        if (body.includes('GetCapabilities')) return soap(`<tds:GetCapabilitiesResponse><tt:Media><tt:XAddr>http://${over.mediaHost || target.host}:${target.port}/onvif/media_service</tt:XAddr></tt:Media></tds:GetCapabilitiesResponse>`)
        if (body.includes('GetProfiles')) return soap('<trt:GetProfilesResponse><trt:Profiles token="profil_1"/></trt:GetProfilesResponse>')
        if (body.includes('GetSnapshotUri')) return soap(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>${over.snapshotUri || `http://${target.host}:${target.port}/snapshot.jpg`}</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`)
        const auth = String(init.headers?.Authorization || init.headers?.authorization || '')
        if (!auth) return new Response('', { status: 401, headers: { 'www-authenticate': 'Digest realm="cam", nonce="abc123", qop="auth"' } })
        return new Response(over.image || JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    })
    return { fetchFn, calls }
}

let logged: string[] = []
beforeEach(() => {
    logged = []
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('ONVIF still with a login', () => {
    it('fetches one still; the password is never in a URL or in plain text on the wire', async () => {
        const { fetchFn, calls } = fakeCamera()
        const image = await onvifSnapshot(target, login, { fetchFn: fetchFn as any })
        expect(image.equals(JPEG)).toBe(true)
        for (const call of calls) {
            expect(call.url).not.toContain(PASSWORT)
            expect(call.url).not.toContain('@')
            expect(JSON.stringify(call.init)).not.toContain(PASSWORT)
            expect(call.init.redirect).toBe('error')
        }
        expect(String(calls[0].init.body)).toContain('PasswordDigest')
        const last = calls.at(-1)!
        expect(String(last.init.headers.Authorization)).toMatch(/^Digest username="betrachter"/)
    })
    it.each([
        ['a still address of another host', { snapshotUri: 'http://10.0.0.9/snapshot.jpg' }],
        ['a still address with credentials', { snapshotUri: `http://admin:admin@${target.host}/snapshot.jpg` }],
        ['a media service on another host', { mediaHost: '10.0.0.9' }],
        ['a non-image answer', { image: Buffer.from('<html>login</html>') }],
    ])('refuses %s', async (_label, over) => {
        const { fetchFn } = fakeCamera(over)
        await expect(onvifSnapshot(target, login, { fetchFn: fetchFn as any })).rejects.toBeInstanceOf(CameraError)
    })
    it('a refused login is said as such and carries no password; nothing is retried with other data', async () => {
        const { fetchFn, calls } = fakeCamera({ soap401: true })
        const error = await onvifSnapshot(target, login, { fetchFn: fetchFn as any }).catch(e => e)
        expect(error).toBeInstanceOf(CameraError)
        expect(error.message).toMatch(/Anmeldung abgelehnt/)
        expect(`${error.message} ${error.stack}`).not.toContain(PASSWORT)
        expect(calls).toHaveLength(1)
    })
})

function camera(extra: Record<string, unknown> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'cam-access-'))
    recordCandidates(dataDir, [{ type: 'camera', host: target.host, port: target.port, via: 'udp', name: 'Einfahrt', seenBy: 'xaventra-nas', evidence: { quelle: 'ONVIF' }, ...extra } as any])
    const device = loadDevices(dataDir)[0]
    return { dataDir, device }
}
const owner = { principalId: 'owner-1', permission: 'owner' }

describe('access only from the owner, sealed', () => {
    it('needs the owner approval of this camera; the password is sealed on disk', () => {
        const { dataDir, device } = camera()
        expect(submitCameraAccess(dataDir, device.id, sensingDeviceFingerprint(device), login, owner).ok).toBe(false)
        approveDevice(dataDir, device.id, owner)
        const approved = loadDevices(dataDir)[0]
        expect(submitCameraAccess(dataDir, device.id, sensingDeviceFingerprint(approved), login, { principalId: 'gast', permission: 'user' }).ok).toBe(false)
        expect(submitCameraAccess(dataDir, device.id, sensingDeviceFingerprint(approved), login, owner).ok).toBe(true)
        expect(readFileSync(join(dataDir, 'secrets', 'kamera', `${device.id}.json`), 'utf8')).not.toContain(PASSWORT)
        expect(readCameraAccess(dataDir, device.id)?.passwort).toBe(PASSWORT)
    })
})

describe('kamera still end to end on Main', () => {
    let root = ''
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cam-root-')); vi.stubEnv('NOVA_RUNTIME_ROOT', root) })
    function ready(extra: Record<string, unknown> = {}) {
        const { dataDir, device } = camera(extra)
        approveDevice(dataDir, device.id, owner)
        const approved = loadDevices(dataDir)[0]
        submitCameraAccess(dataDir, device.id, sensingDeviceFingerprint(approved), login, owner)
        return { dataDir, device: approved }
    }
    const shot = (bytes = JPEG) => ({ nodeId: 'xaventra-nas', capturedAt: new Date().toISOString(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64'), mimeType: 'image/jpeg' })

    it('the login goes only to the finding node and only for that address; the still lands private and sendable', async () => {
        const { dataDir, device } = ready()
        const request = vi.fn(async () => shot())
        const result = await cameraStandbild(dataDir, device.id, { requestNodeKamera: request as any, principalId: 'owner-1', runId: 'run-1', localNode: 'xaventra-spark' })
        expect(result).toMatchObject({ ok: true })
        expect(request).toHaveBeenCalledOnce()
        const [node, payload] = request.mock.calls[0] as any
        expect(node).toBe('xaventra-nas')
        expect(payload).toMatchObject({ operation: 'kamera', kamera: { host: target.host, port: target.port }, zugang: login })
        expect(JSON.stringify(result)).not.toContain(PASSWORT)
        const path = (result as any).path as string
        expect(path).toContain(join('.nova-vision', 'kamera'))
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
        expect(assertSendableImage(path)).toMatchObject({ source: 'kamera', mime: 'image/jpeg' })
    })
    it('Gegenprobe: a camera without access gets an honest sentence, nothing is guessed or sent', async () => {
        const { dataDir, device } = camera()
        const request = vi.fn()
        const result = await cameraStandbild(dataDir, device.id, { requestNodeKamera: request as any, principalId: 'o', runId: 'r', localNode: 'x' })
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/Zugang/)
        expect(result.message).toMatch(/rate nichts/)
        expect(request).not.toHaveBeenCalled()
    })
    it('a pure RTSP camera gets the honest sentence', async () => {
        const { dataDir, device } = ready({ port: 554, via: 'tcp', evidence: { quelle: 'RTSP OPTIONS (ohne Anmeldung)' } })
        const request = vi.fn()
        const result = await cameraStandbild(dataDir, device.id, { requestNodeKamera: request as any, principalId: 'o', runId: 'r', localNode: 'x' })
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/nur RTSP/)
        expect(request).not.toHaveBeenCalled()
    })
    it('no fallback: without a path to the node nothing else is tried, and the error stays clean', async () => {
        const { dataDir, device } = ready()
        const request = vi.fn(async () => { throw new Error('No direct node capture path') })
        const result = await cameraStandbild(dataDir, device.id, { requestNodeKamera: request as any, principalId: 'o', runId: 'r', localNode: 'x' })
        expect(result.ok).toBe(false)
        expect(request).toHaveBeenCalledOnce()
        expect(JSON.stringify(result) + logged.join('\n')).not.toContain(PASSWORT)
    })
    it('stills live at most 24 h', () => {
        const dir = join(root, '.nova-vision', 'kamera'); mkdirSync(dir, { recursive: true })
        const old = join(dir, 'dev-0123456789_1_alt.jpg'), fresh = join(dir, 'dev-0123456789_2_neu.jpg')
        writeFileSync(old, JPEG); writeFileSync(fresh, JPEG)
        const past = new Date(Date.now() - 25 * 3600_000); utimesSync(old, past, past)
        expect(pruneCameraStills()).toBe(1)
        expect(existsSync(old)).toBe(false)
        expect(readdirSync(dir)).toEqual(['dev-0123456789_2_neu.jpg'])
    })
    it('the password appears in no log at all', async () => {
        const { dataDir, device } = ready()
        await cameraStandbild(dataDir, device.id, { requestNodeKamera: (async () => shot()) as any, principalId: 'o', runId: 'r', localNode: 'x' })
        expect(logged.join('\n')).not.toContain(PASSWORT)
    })
})

describe('a released camera stays on request', () => {
    it('is not polled by the monitoring', () => {
        const { dataDir, device } = camera()
        approveDevice(dataDir, device.id, owner)
        expect(loadDevices(dataDir)[0].status).toBe('eingerichtet')
        expect(monitoredDevices(dataDir)).toEqual([])
    })
})
