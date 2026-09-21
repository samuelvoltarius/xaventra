import { beforeEach, describe, expect, it, vi } from 'vitest'

const mesh = vi.hoisted(() => ({
    sendAgentRequest: vi.fn(),
    waitForMeshRunResult: vi.fn(),
    cancelMeshRun: vi.fn(),
}))

vi.mock('../mesh/mesh-transport-runtime.js', () => mesh)

import { spawnSubagent } from './subagent-orchestrator.js'

describe('mesh subagent transport boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mesh.sendAgentRequest.mockResolvedValue({
            requestId: 'request-1234',
            ack: { status: 'delivered', transport: 'direct' },
        })
        mesh.cancelMeshRun.mockResolvedValue({ status: 'delivered' })
    })

    it('uses the typed signed mesh path and returns its correlated result', async () => {
        mesh.waitForMeshRunResult.mockResolvedValue({
            requestId: 'request-1234', success: true, result: 'remote result',
            evidence: [{ tool: 'read_file', resultHash: 'hash', verified: true }],
        })

        const result = await spawnSubagent({
            task: 'read the fixture', userId: 'owner-1', meshNode: 'worker-1',
            tools: ['read_file', 'run_command'], timeoutMs: 500,
        })

        expect(mesh.sendAgentRequest).toHaveBeenCalledWith('worker-1', 'read the fixture', expect.objectContaining({
            userId: 'owner-1', allowedTools: ['read_file'], idempotencyKey: expect.stringMatching(/^subagent:/),
        }))
        expect(mesh.waitForMeshRunResult).toHaveBeenCalledWith('request-1234', 500, expect.any(AbortSignal))
        expect(result).toMatchObject({ status: 'completed', mode: 'mesh', output: 'remote result', toolsUsed: ['read_file'] })
    })

    it('sends a typed cancellation on timeout and never replays locally', async () => {
        mesh.waitForMeshRunResult.mockImplementation((_id: string, _timeout: number, signal: AbortSignal) =>
            new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true })))

        const result = await spawnSubagent({
            task: 'slow remote work', userId: 'owner-1', meshNode: 'worker-1',
            tools: ['read_file'], timeoutMs: 25,
        })

        expect(result).toMatchObject({ status: 'timeout', mode: 'mesh' })
        await vi.waitFor(() => expect(mesh.cancelMeshRun).toHaveBeenCalledWith('worker-1', 'request-1234', 'cancelled'))
    })

    it('does not fall back locally after an unconfirmed remote delivery', async () => {
        mesh.sendAgentRequest.mockResolvedValue({
            requestId: 'request-queued',
            ack: { status: 'queued', transport: 'outbox' },
        })
        mesh.waitForMeshRunResult.mockResolvedValue(undefined)

        const result = await spawnSubagent({ task: 'maybe delivered', meshNode: 'worker-1', timeoutMs: 30 })

        expect(result).toMatchObject({ status: 'timeout', mode: 'mesh' })
        expect(mesh.cancelMeshRun).toHaveBeenCalledWith('worker-1', 'request-queued', 'timeout')
    })
})
