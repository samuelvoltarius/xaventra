import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.82.0: power comes from the one GPU source (doctor/nvidia-smi.ts via gpu-runtime):
// last value at once, refreshed asynchronously — never a blocking spawn per run.
const gpu = vi.hoisted(() => ({ rows: [['250.5']] as string[][] | null, calls: 0 }))
const cachedNvidiaQuery = vi.hoisted(() => vi.fn(() => { gpu.calls++; return gpu.rows }))
vi.mock('../doctor/nvidia-smi.js', () => ({ cachedNvidiaQuery }))
const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: '250.5\n' })))
vi.mock('node:child_process', () => ({ spawnSync }))
import { estimateUsageCost } from './model-pricing.js'

beforeEach(() => {
    // Leave the test-mode shortcut so the real measurement path is exercised.
    vi.stubEnv('VITEST', 'false')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NOVA_LOCAL_POWER_WATTS', '')
    cachedNvidiaQuery.mockClear()
    spawnSync.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('local power measurement (R2 A20)', () => {
    it('never asks the GPU for a cloud model', () => {
        estimateUsageCost({ provider: 'openai', model: 'gpt-5', inputTokens: 10, outputTokens: 10, durationMs: 1000 })
        expect(cachedNvidiaQuery).not.toHaveBeenCalled()
    })

    it('reuses one reading from the one GPU source and never spawns nvidia-smi itself', () => {
        const first = estimateUsageCost({ provider: 'vllm', model: 'qwen', durationMs: 3_600_000 })
        estimateUsageCost({ provider: 'vllm', model: 'qwen', durationMs: 3_600_000 })
        expect(first.energyUsd).toBeGreaterThan(0)
        expect(cachedNvidiaQuery).toHaveBeenCalledTimes(1)
        expect(cachedNvidiaQuery).toHaveBeenCalledWith(['power.draw'], 30_000)
        expect(spawnSync).not.toHaveBeenCalled()
    })
})
