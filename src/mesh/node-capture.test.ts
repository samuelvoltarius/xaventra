import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureEnrolledNode, inputEnrolledNode, validateNodeCapture, validateNodeInput, validNodeCaptureRequest } from './node-capture.js'

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

const requestId = '12345678-1234-1234-1234-123456789abc'
const inputRequest = (extra: Record<string, unknown> = {}) => ({ operation: 'input', principalId: 'owner', runId: 'run-1', requestId, action: { action: 'click', x: 10, y: 20, button: 'left' }, ...extra })
describe('enrolled node input with a fresh capture as read-back', () => {
    it('accepts only typed bounded input requests', () => {
        expect(validNodeCaptureRequest(inputRequest())).toBe(true)
        expect(validNodeCaptureRequest(inputRequest({ action: { action: 'open_url', url: 'https://example.com/' } }))).toBe(true)
        for (const bad of [inputRequest({ requestId: 'x' }), inputRequest({ action: { action: 'exec', command: 'id' } }), inputRequest({ action: { action: 'open_url', url: 'http://192.168.0.1/' } }),
            inputRequest({ display: ':1' }), { operation: 'capture', principalId: 'owner', runId: 'r', requestId }])
            expect(validNodeCaptureRequest(bad)).toBe(false)
    })
    it('needs capture AND input enrollment on the node; never acts otherwise', async () => {
        const input = vi.fn(async () => ({ requestId, status: 'completed', replayed: false })), capture = vi.fn(async () => image), check = vi.fn(async () => {})
        vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '1'); vi.stubEnv('NOVA_CAPTURE_SOCKET', '/private/socket'); vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/private/token')
        vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED', '')
        await expect(inputEnrolledNode('worker', inputRequest() as any, check, input, capture)).rejects.toThrow('input not enrolled')
        expect(input).not.toHaveBeenCalled()
    })
    it('returns the input receipt plus a fresh capture and checks authority around both', async () => {
        vi.stubEnv('NOVA_MESH_CAPTURE_ENABLED', '1'); vi.stubEnv('NOVA_CAPTURE_SOCKET', '/private/socket'); vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/private/token'); vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED', '1')
        const order: string[] = []
        const input = vi.fn(async () => { order.push('input'); return { requestId, hash: 'h', status: 'completed', replayed: false } })
        const capture = vi.fn(async () => { order.push('capture'); return image }), check = vi.fn(async () => { order.push('check') })
        const receipt = await inputEnrolledNode('worker', inputRequest() as any, check, input, capture)
        expect(receipt).toMatchObject({ nodeId: 'worker', input: { requestId, status: 'completed', replayed: false }, capture: { nodeId: 'worker', bytes: 24 } })
        expect(order.indexOf('input')).toBeLessThan(order.indexOf('capture'))
        expect(order[0]).toBe('check')
        expect(validateNodeInput(receipt, 'worker', requestId)).toEqual(receipt)
        expect(() => validateNodeInput(receipt, 'other', requestId)).toThrow()
        expect(() => validateNodeInput({ ...receipt, input: { ...receipt.input, requestId: '0'.repeat(8) + requestId.slice(8) } }, 'worker', requestId)).toThrow()
        expect(() => validateNodeInput({ ...receipt, capture: { ...receipt.capture, sha256: '0'.repeat(64) } }, 'worker', requestId)).toThrow()
        // A receipt of a different input is never accepted as this step.
        await expect(inputEnrolledNode('worker', inputRequest() as any, check, async () => ({ requestId: 'other', status: 'completed' }), capture)).rejects.toThrow()
    })
})
