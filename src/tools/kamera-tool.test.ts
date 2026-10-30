import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ context: { authUserId: 'owner-1', runId: 'run-1', channel: 'desktop' }, role: 'owner', request: vi.fn(), dataDir: '' }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => fixture.context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => fixture.role }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ requestNodeKamera: fixture.request }))
vi.mock('../mesh/mesh-registry.js', () => ({ getLocalNodeId: () => 'xaventra-main' }))
vi.mock('../sensing/runtime.js', () => ({ sensingDataDir: () => fixture.dataDir }))
import { kameraStandbildTool } from './kamera-tool.js'
import { approveDevice, loadDevices, recordCandidates, sensingDeviceFingerprint } from '../sensing/device-registry.js'
import { submitCameraAccess } from '../sensing/camera-access.js'

const PASSWORT = ['fixture', 'kamera', String(4711), 'x'].join('-')
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64)])
const owner = { principalId: 'owner-1', permission: 'owner' }
beforeEach(() => {
    vi.clearAllMocks(); fixture.role = 'owner'
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
