import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ context: { authUserId: '12345', runId: 'owner-run', channel: 'telegram' }, role: 'owner', capture: vi.fn(), send: vi.fn() }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => fixture.context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => fixture.role }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ currentCaptureNodes: () => ['spark', 'worker'], requestNodeCapture: fixture.capture }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: fixture.send }))
import { meshScreenshotTool } from './mesh-screenshot-tool.js'
beforeEach(() => {
    fixture.role = 'owner'; fixture.context.channel = 'telegram'; vi.clearAllMocks()
    fixture.capture.mockResolvedValue({ bytes: 24, base64: Buffer.alloc(24).toString('base64'), sha256: 'a'.repeat(64), capturedAt: new Date().toISOString() })
    fixture.send.mockResolvedValue('✅ Foto gesendet: fixture')
})
describe('owner-only node images with delivery receipts', () => {
    it('sends all captures only to the authenticated requester and never returns pixels in model text', async () => {
        const result = await meshScreenshotTool.handler({ node_id: 'all', chat_id: '99999' }) as any
        expect(result).toMatchObject({ success: true, delivered: true, captured: true })
        expect(result.captures.map((r: any) => r.nodeId)).toEqual(['spark', 'worker'])
        expect(fixture.send).toHaveBeenCalledTimes(2)
        expect(fixture.send.mock.calls.every(([p]) => p.chat_id === '12345')).toBe(true)
        expect(JSON.stringify(result)).not.toContain('base64')
    })
    it('reports headless and delivery failures individually, not all-images success', async () => {
        fixture.capture.mockRejectedValueOnce(new Error('headless: no enrolled adapter'))
        fixture.send.mockResolvedValue('delivery failed')
        const result = await meshScreenshotTool.handler({ node_id: 'all' }) as any
        expect(result).toMatchObject({ success: false, delivered: false, captured: true })
        expect(result.captures[0]).toMatchObject({ captured: false, error: expect.stringContaining('headless') })
        expect(result.captures[1]).toMatchObject({ captured: true, delivered: false })
    })
    it('does not capture for a non-owner, unknown target or unbound delivery channel', async () => {
        fixture.role = 'user'
        expect(await meshScreenshotTool.handler({ node_id: 'all' })).toMatchObject({ success: false })
        fixture.role = 'owner'
        expect(await meshScreenshotTool.handler({ node_id: 'foreign' })).toMatchObject({ success: false })
        fixture.context.channel = 'api'
        expect(await meshScreenshotTool.handler({ node_id: 'all' })).toMatchObject({ success: false })
        expect(fixture.capture).not.toHaveBeenCalled()
    })
})
