import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: '250.5\n' })))
vi.mock('node:child_process', () => ({ spawnSync }))
import { estimateUsageCost } from './model-pricing.js'

beforeEach(() => {
    // Leave the test-mode shortcut so the real measurement path is exercised.
    vi.stubEnv('VITEST', 'false')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NOVA_LOCAL_POWER_WATTS', '')
    spawnSync.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('local power measurement (R2 A20)', () => {
    it('never spawns nvidia-smi for a cloud model', () => {
        estimateUsageCost({ provider: 'openai', model: 'gpt-5', inputTokens: 10, outputTokens: 10, durationMs: 1000 })
        expect(spawnSync).not.toHaveBeenCalled()
    })

    it('reuses one reading instead of blocking on every local run', () => {
        const first = estimateUsageCost({ provider: 'vllm', model: 'qwen', durationMs: 3_600_000 })
        estimateUsageCost({ provider: 'vllm', model: 'qwen', durationMs: 3_600_000 })
        expect(first.energyUsd).toBeGreaterThan(0)
        expect(spawnSync).toHaveBeenCalledTimes(1)
    })
})
