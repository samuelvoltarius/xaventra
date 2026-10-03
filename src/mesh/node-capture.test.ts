import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureEnrolledNode, validateNodeCapture, validNodeCaptureRequest } from './node-capture.js'

const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
const receipt = () => ({ nodeId: 'worker', capturedAt: new Date().toISOString(), bytes: image.length,
    sha256: createHash('sha256').update(image).digest('hex'), base64: image.toString('base64'), mimeType: 'image/png' })
afterEach(() => vi.unstubAllEnvs())
describe('source-bound enrolled node captures', () => {
    it('rejects paths, untyped requests, foreign nodes, stale and altered images', () => {
        expect(validNodeCaptureRequest({ operation: 'capture', principalId: 'owner', runId: 'run-1' })).toBe(true)
        expect(validNodeCaptureRequest({ operation: 'capture', principalId: 'owner', runId: 'run-1', path: '/any' })).toBe(false)
        expect(validNodeCaptureRequest({ operation: 'capture', principalId: '../owner', runId: 'r' })).toBe(false)
        const original = receipt()
        expect(validateNodeCapture(original, 'worker')).toEqual(original)
        for (const altered of [{ nodeId: 'other' }, { sha256: '0'.repeat(64) }, { bytes: 25 }, { capturedAt: '2020-01-01' }, { base64: 'abc' }, { mimeType: 'text/plain' }]) {
            expect(() => validateNodeCapture({ ...receipt(), ...altered }, 'worker')).toThrow()
        }
    })
    it('never tries a desktop without local enrollment and a graphical adapter', async () => {
        const capture = vi.fn(async () => image), check = vi.fn(async () => {})
        vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '')
        await expect(captureEnrolledNode('worker', check, capture)).rejects.toThrow('not enrolled')
        vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '1'); vi.stubEnv('NOVA_CAPTURE_SOCKET', '')
        await expect(captureEnrolledNode('worker', check, capture)).rejects.toThrow('No enrolled')
        expect(capture).not.toHaveBeenCalled()
    })
    it('preserves locked-session denial and checks Main authority before and after capture', async () => {
        vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '1'); vi.stubEnv('NOVA_CAPTURE_SOCKET', '/private/socket'); vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/private/token')
        const check = vi.fn(async () => {})
        await expect(captureEnrolledNode('worker', check, async () => { throw new Error('session locked') })).rejects.toThrow('session locked')
        check.mockClear()
        expect(await captureEnrolledNode('worker', check, async () => image)).toMatchObject({ nodeId: 'worker', bytes: 24 })
        expect(check).toHaveBeenCalledTimes(2)
        const loseAuthority = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'))
        await expect(captureEnrolledNode('worker', loseAuthority, async () => image)).rejects.toThrow('lease lost')
    })
})
