import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ context: { authUserId: '12345', runId: 'owner-run', channel: 'telegram' }, capture: vi.fn(), send: vi.fn() }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => fixture.context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => 'owner' }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ currentCaptureNodes: () => ['spark', 'lab'], requestNodeCapture: fixture.capture }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: fixture.send }))
const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString()
vi.mock('../mesh/mesh-registry.js', () => ({
    discoverNodes: async () => [
        { node_id: 'spark', last_heartbeat: iso(5_000) }, { node_id: 'lab', last_heartbeat: iso(5_000) },
        { node_id: 'ns1', last_heartbeat: iso(5_000) }, { node_id: 'nas', last_heartbeat: iso(20 * 60_000) },
    ],
}))
import { meshScreenshotTool } from './mesh-screenshot-tool.js'
import { captureReason } from '../mesh/capture-reason.js'
import { nodeScreenshotResponse } from '../core/tool-evidence-response.js'

beforeEach(() => {
    vi.clearAllMocks()
    fixture.capture.mockImplementation(async (nodeId: string) => {
        if (nodeId === 'lab') throw new Error('Error: Node capture not enrolled; headless nodes have no desktop image')
        return { bytes: 24, base64: Buffer.alloc(24).toString('base64'), sha256: 'a'.repeat(64), capturedAt: new Date().toISOString() }
    })
    fixture.send.mockResolvedValue('✅ Foto gesendet: fixture')
})

describe('"Screenshot von allen Nodes und Main": every node gets a line', () => {
    it('lists picture, headless/not enrolled and offline nodes with plain reasons', async () => {
        const result = await meshScreenshotTool.handler({ node_id: 'all' }) as any
        expect(result.captures.map((r: any) => r.nodeId).sort()).toEqual(['lab', 'nas', 'ns1', 'spark'])
        const text = nodeScreenshotResponse([{ toolName: 'mesh_screenshot', success: false, result }])
        expect(text).toContain('spark: Bild aufgenommen; Bildzustellung bestätigt')
        expect(text).toMatch(/lab: kein Bild aufgenommen.*keine Bildschirmaufnahme möglich/)
        expect(text).toMatch(/ns1: kein Bild aufgenommen.*kein aktueller Aufnahme-Kanal/)
        expect(text).toMatch(/nas: kein Bild aufgenommen.*offline \(zuletzt gesehen vor 20 min\)/)
        expect(text).not.toMatch(/Error: Error/)
        expect(text).not.toContain('NOVA_MESH_CAPTURE')
    })
    it('translates raw errors once, without doubled prefixes', () => {
        expect(captureReason('Error: Error: Node capture not enrolled; headless nodes have no desktop image')).toContain('keine Bildschirmaufnahme möglich')
        expect(captureReason('Node capture timed out; no image confirmed')).toContain('keine Antwort')
        expect(captureReason('Error: boom')).toBe('Aufnahme fehlgeschlagen: boom')
    })
})
