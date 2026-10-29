import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ context: { authUserId: '12345', runId: 'owner-run', channel: 'telegram' }, role: 'owner', input: vi.fn() }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => fixture.context }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => fixture.role }))
vi.mock('../mesh/mesh-transport-runtime.js', () => ({ currentCaptureNodes: () => ['spark', 'lab'], requestNodeInput: fixture.input }))
import { meshDesktopInputTool } from './mesh-desktop-input-tool.js'

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
const receipt = (requestId: string, replayed = false) => ({ nodeId: 'lab', input: { requestId, status: 'completed', replayed },
    capture: { nodeId: 'lab', capturedAt: new Date().toISOString(), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), base64: png.toString('base64'), mimeType: 'image/png' } })
beforeEach(() => {
    fixture.role = 'owner'; fixture.context.channel = 'telegram'; vi.clearAllMocks()
    vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', '1')
    fixture.input.mockImplementation(async (_node: string, payload: any) => receipt(payload.requestId))
})
afterEach(() => vi.unstubAllEnvs())
const call = (params: Record<string, unknown> = {}) => meshDesktopInputTool.handler({ node_id: 'lab', action: '{"action":"click","x":10,"y":20,"button":"left"}', step: 'klick-1', ...params }) as Promise<any>

describe('mesh_desktop_input: owner-only input on an enrolled node, judged by a fresh capture', () => {
    it('returns the private path of the fresh capture for read-back, never pixels in model text', async () => {
        const result = await call()
        expect(result).toMatchObject({ success: true, status: 'executed', executedNow: true, nodeId: 'lab', capture: { sha256: receipt('x').capture.sha256 } })
        expect(existsSync(result.capture.path)).toBe(true)
        expect(JSON.stringify(result)).not.toContain('base64')
        expect(result.message).toMatch(/analyze_image/)
    })
    it('binds the idempotency id to run, owner, node and step (same step = same id, other step = new id)', async () => {
        await call(); await call(); await call({ step: 'klick-2' }); await call({ node_id: 'spark' })
        const ids = fixture.input.mock.calls.map(([, p]) => p.requestId)
        expect(ids[0]).toBe(ids[1])
        expect(new Set(ids).size).toBe(3)
        expect(ids[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
        expect(fixture.input.mock.calls[0][1]).toMatchObject({ operation: 'input', principalId: '12345', runId: 'owner-run', action: { action: 'click', x: 10, y: 20, button: 'left' } })
    })
    it('says honestly when an earlier identical step was only replayed', async () => {
        fixture.input.mockImplementation(async (_node: string, payload: any) => receipt(payload.requestId, true))
        expect(await call()).toMatchObject({ success: true, status: 'replayed', executedNow: false })
    })
    it('2.90.0: on by default on Main (the node keeps its own opt-in); off when switched off', async () => {
        vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', '')
        expect(await call()).toMatchObject({ success: true })
        vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', '0')
        expect(await call()).toMatchObject({ success: false })
        vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', 'off')
        expect(await call()).toMatchObject({ success: false })
    })
    it('does nothing without Main opt-in, owner, known single node or a valid action/step', async () => {
        vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', 'false')
        expect(await call()).toMatchObject({ success: false })
        vi.stubEnv('NOVA_MESH_DESKTOP_INPUT_ENABLED', '1')
        fixture.role = 'user'
        expect(await call()).toMatchObject({ success: false })
        fixture.role = 'owner'
        for (const params of [{ node_id: 'all' }, { node_id: 'foreign' }, { action: '{"action":"exec","command":"id"}' }, { action: 'kein json' },
            { action: '{"action":"open_url","url":"http://192.168.0.1/"}' }, { step: '../x' }, { step: '' }])
            expect(await call(params)).toMatchObject({ success: false })
        expect(fixture.input).not.toHaveBeenCalled()
    })
    it('reports an uncertain effect without claiming success', async () => {
        fixture.input.mockRejectedValueOnce(new Error('Desktop input unavailable or uncertain; do not repeat automatically'))
        const result = await call()
        expect(result).toMatchObject({ success: false, executedNow: false })
        expect(result.error).toMatch(/uncertain/)
    })
})

describe('refusal at the workstation', () => {
    it('is shown as a safe refusal: nothing executed, do not repeat, with the reason', async () => {
        fixture.input.mockRejectedValueOnce(new Error('Error: Desktop action refused: nicht auf der Erlaubnisliste: wikipedia.org'))
        const result = await call({ action: '{"action":"open_url","url":"https://wikipedia.org/"}', step: 'oeffnen-1' })
        expect(result).toMatchObject({ success: false, refused: true, executedNow: false, status: 'refused' })
        expect(result.error).toContain('nicht auf der Erlaubnisliste: wikipedia.org')
        expect(result.message).toMatch(/nichts ausgeführt/)
        expect(result.message).toMatch(/nicht wiederholen/)
    })
    it('an uncertain failure is not presented as a refusal', async () => {
        fixture.input.mockRejectedValueOnce(new Error('Desktop input unavailable or uncertain; do not repeat automatically'))
        const result = await call()
        expect(result.refused).not.toBe(true)
    })
})

describe('node short names', () => {
    it('resolves a unique short name (lab -> xaventra-lab), never an ambiguous or unknown one', async () => {
        const { resolveCaptureNode } = await import('./mesh-screenshot-tool.js')
        expect(resolveCaptureNode('lab', ['xaventra-spark', 'xaventra-lab'])).toBe('xaventra-lab')
        expect(resolveCaptureNode('xaventra-lab', ['xaventra-lab'])).toBe('xaventra-lab')
        expect(resolveCaptureNode('Lab', ['xaventra-spark', 'xaventra-lab'])).toBe('xaventra-lab')
        expect(resolveCaptureNode('ns', ['xaventra-ns1', 'xaventra-ns2'])).toBeUndefined()
        expect(resolveCaptureNode('lab', ['xaventra-lab', 'other-lab'])).toBeUndefined()
        expect(resolveCaptureNode('foreign', ['xaventra-lab'])).toBeUndefined()
        expect(resolveCaptureNode('', ['xaventra-lab'])).toBeUndefined()
    })
})
