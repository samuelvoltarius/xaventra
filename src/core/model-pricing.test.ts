import { describe, expect, it } from 'vitest'
import { estimateUsageCost, parseNvidiaPowerDraw } from './model-pricing.js'

describe('central model pricing', () => {
    it('prices verified cloud tokens in USD', () => {
        const cost = estimateUsageCost({ provider: 'openai', model: 'gpt-5', inputTokens: 1_000_000, outputTokens: 1_000_000 })
        expect(cost.cloudUsd).toBe(11.25)
        expect(cost.priced).toBe(true)
    })

    it('prices Novas configured MiniMax M3 route', () => {
        const cost = estimateUsageCost({ provider: 'minimax', model: 'MiniMax-M3', inputTokens: 1_000_000, outputTokens: 1_000_000 })
        expect(cost.cloudUsd).toBe(1.5)
    })

    it('uses GPT-5.4 pricing and the documented long-context multiplier', () => {
        const short = estimateUsageCost({ provider: 'openai', model: 'gpt-5.4', inputTokens: 100_000, outputTokens: 10_000 })
        expect(short.totalUsd).toBeCloseTo(0.4)
        const long = estimateUsageCost({ provider: 'openai', model: 'gpt-5.4', inputTokens: 1_000_000, outputTokens: 1_000_000 })
        expect(long.totalUsd).toBe(27.5)
    })

    it('does not inherit the price of a similarly named model', () => {
        const unknown = estimateUsageCost({ provider: 'openai', model: 'gpt-5.99', inputTokens: 1_000, outputTokens: 1_000 })
        expect(unknown.priced).toBe(false)
    })

    it('accounts for local energy when power is known', () => {
        const cost = estimateUsageCost({ provider: 'vllm', model: 'local-qwen', durationMs: 3_600_000, powerWatts: 500 })
        expect(cost.energyUsd).toBeCloseTo(0.15)
        expect(cost.cloudUsd).toBe(0)
    })

    it('parses NVIDIA power telemetry without inventing missing values', () => {
        expect(parseNvidiaPowerDraw('13.36\n')).toBe(13.36)
        expect(parseNvidiaPowerDraw('42,5')).toBe(42.5)
        expect(parseNvidiaPowerDraw('[N/A]')).toBe(0)
    })
})
