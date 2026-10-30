import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ context: { authUserId: 'owner-1', runId: 'run-1', channel: 'desktop' }, role: 'owner', request: vi.fn(), send: vi.fn(), dataDir: '' }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => fixture.context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => fixture.role }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ requestNodeKamera: fixture.request }))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'xaventra-main' }))
vi.mock('../sensing/runtime.js', () => ({ sensingDataDir: () => fixture.dataDir }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: fixture.send }))
import { kameraStandbildTool } from './kamera-tool.js'
import { approveDevice, loadDevices, recordCandidates, sensingDeviceFingerprint } from '../sensing/device-registry.js'
import { submitCameraAccess } from '../sensing/camera-access.js'

const PASSWORT = ['fixture', 'kamera', String(4711), 'x'].join('-')
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64)])
const owner = { principalId: 'owner-1', permission: 'owner' }
beforeEach(() => {
    vi.clearAllMocks(); fixture.role = 'owner'; fixture.context.channel = 'desktop'
    fixture.send.mockResolvedValue('✅ Foto gesendet: einfahrt.jpg')
    fixture.dataDir = mkdtempSync(join(tmpdir(), 'kam-tool-'))
    vi.stubEnv('NOVA_RUNTIME_ROOT', fixture.dataDir)
    recordCandidates(fixture.dataDir, [{ type: 'camera', host: '192.168.1.60', port: 8000, via: 'udp', name: 'Einfahrt', seenBy: 'xaventra-nas' }])
    const id = loadDevices(fixture.dataDir)[0].id
    approveDevice(fixture.dataDir, id, owner)
    submitCameraAccess(fixture.dataDir, id, sensingDeviceFingerprint(loadDevices(fixture.dataDir)[0]), { benutzer: 'betrachter', passwort: PASSWORT }, owner)
    fixture.request.mockResolvedValue({ nodeId: 'xaventra-nas', capturedAt: new Date().toISOString(), bytes: JPEG.length, sha256: createHash('sha256').update(JPEG).digest('hex'), base64: JPEG.toString('base64'), mimeType: 'image/jpeg' })
})

describe('kamera_standbild', () => {
    it('gives the model a private path, never a login', async () => {
        const result = await kameraStandbildTool.handler({ kamera: 'einfahrt' }) as any
        expect(result).toMatchObject({ success: true })
        expect(result.path).toContain('kamera')
        expect(JSON.stringify(result)).not.toContain(PASSWORT)
        expect(JSON.stringify(result)).not.toContain('betrachter')
        expect(fixture.request.mock.calls[0][0]).toBe('xaventra-nas')
    })
    it('owner only; unknown camera ends without a request', async () => {
        fixture.role = 'user'
        expect(await kameraStandbildTool.handler({ kamera: 'einfahrt' })).toMatchObject({ success: false })
        fixture.role = 'owner'
        expect(await kameraStandbildTool.handler({ kamera: 'garage' })).toMatchObject({ success: false })
        expect(fixture.request).not.toHaveBeenCalled()
    })
    it('has no parameter for an address, a user or a password', () => {
        expect(kameraStandbildTool.parameters.map(p => p.name)).toEqual(['kamera'])
    })
})

describe('delivery of the still', () => {
    it('Telegram: to the asking owner, as an attachment over the existing sending, with the private path kept', async () => {
        fixture.context.channel = 'telegram'
        const result = await kameraStandbildTool.handler({ kamera: 'einfahrt', chat_id: '99999' }) as any
        expect(result).toMatchObject({ success: true, delivered: true })
        expect(fixture.send).toHaveBeenCalledOnce()
        const [args] = fixture.send.mock.calls[0]
        expect(args.path).toBe(result.path)
        // The recipient comes only from the authenticated context of send-file, never from a model argument.
        expect(args.chat_id).toBeUndefined()
        expect(result.message).toMatch(/geschickt/)
    })
    it('a failed delivery is said honestly; the still stays private', async () => {
        fixture.context.channel = 'telegram'
        fixture.send.mockResolvedValue('❌ Telegram nicht verbunden')
        const result = await kameraStandbildTool.handler({ kamera: 'einfahrt' }) as any
        expect(result).toMatchObject({ success: true, delivered: false })
        expect(result.message).toMatch(/nicht zustellen/)
        expect(result.message).not.toMatch(/geschickt/)
    })
    it('a throwing delivery is the same honest sentence', async () => {
        fixture.context.channel = 'telegram'
        fixture.send.mockRejectedValue(new Error('network'))
        expect(await kameraStandbildTool.handler({ kamera: 'einfahrt' })).toMatchObject({ success: true, delivered: false })
    })
    it('desktop has no attachment way: nothing is sent, and the answer says so', async () => {
        const result = await kameraStandbildTool.handler({ kamera: 'einfahrt' }) as any
        expect(fixture.send).not.toHaveBeenCalled()
        expect(result).toMatchObject({ success: true, delivered: false })
        expect(result.message).toMatch(/in diesem Kanal/i)
    })
    it('other channels get no still at all, and no guest either', async () => {
        fixture.context.channel = 'whatsapp'
        expect(await kameraStandbildTool.handler({ kamera: 'einfahrt' })).toMatchObject({ success: false })
        fixture.context.channel = 'telegram'; fixture.role = 'guest'
        expect(await kameraStandbildTool.handler({ kamera: 'einfahrt' })).toMatchObject({ success: false })
        expect(fixture.request).not.toHaveBeenCalled()
        expect(fixture.send).not.toHaveBeenCalled()
    })
})

describe('spy on Main: the test password after a fetch', () => {
    it('is in no file of the data folder (except the sealed vault key material) and in no log', async () => {
        const logged: string[] = []
        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
        fixture.context.channel = 'telegram'
        await kameraStandbildTool.handler({ kamera: 'einfahrt' })
        fixture.request.mockRejectedValueOnce(new Error('CameraError: Die Kamera hat die Anmeldung abgelehnt.'))
        await kameraStandbildTool.handler({ kamera: 'einfahrt' })
        const firstCall = fixture.request.mock.calls[0]
        vi.restoreAllMocks()
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
        const files = walk(fixture.dataDir)
        expect(files.length).toBeGreaterThan(1)
        for (const path of files) expect(readFileSync(path, 'latin1').includes(PASSWORT), path).toBe(false)
        expect(logged.join(String.fromCharCode(10))).not.toContain(PASSWORT)
        // The request itself is the one place the login exists, only in memory for that node.
        expect(firstCall[1].zugang.passwort).toBe(PASSWORT)
    })
})
