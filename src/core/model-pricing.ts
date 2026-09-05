import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface ModelPrice {
    inputUsdPerMillion: number
    outputUsdPerMillion: number
    provider?: string
    source: string
    effectiveAt: string
}

export interface UsageCostEstimate {
    cloudUsd: number
    energyUsd: number
    hardwareUsd: number
    totalUsd: number
    priced: boolean
    estimated: boolean
    source: string
}

// Versioned defaults are intentionally small. Operators can update prices
// without a release through .nova-data/model-pricing.json.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
    'gpt-5.4': { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, provider: 'openai', source: 'https://developers.openai.com/api/docs/models/gpt-5.4', effectiveAt: '2026-07-19' },
    'gpt-5.4-mini': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, provider: 'openai', source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini', effectiveAt: '2026-07-19' },
    'gpt-5': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10, provider: 'openai', source: 'https://developers.openai.com/api/docs/models/gpt-5', effectiveAt: '2026-07-18' },
    'gemini-3.5-flash': { inputUsdPerMillion: 1.5, outputUsdPerMillion: 9, provider: 'google', source: 'https://ai.google.dev/gemini-api/docs/pricing', effectiveAt: '2026-07-18' },
    'minimax-m3': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2, provider: 'minimax', source: 'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise', effectiveAt: '2026-07-18' },
    'minimax-m2.7': { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2, provider: 'minimax', source: 'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise', effectiveAt: '2026-07-18' },
    'minimax-m2.7-highspeed': { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.4, provider: 'minimax', source: 'https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise', effectiveAt: '2026-07-18' },
}

let cached: Record<string, ModelPrice> | null = null

function normalized(value: unknown = ''): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getModelPrices(): Record<string, ModelPrice> {
    if (cached) return cached
    const prices = { ...DEFAULT_PRICES }
    const path = process.env.NOVA_MODEL_PRICING_FILE || join(process.cwd(), '.nova-data', 'model-pricing.json')
    try {
        if (existsSync(path)) {
            const custom = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelPrice>
            for (const [model, price] of Object.entries(custom)) {
                if (Number.isFinite(price?.inputUsdPerMillion) && Number.isFinite(price?.outputUsdPerMillion)) {
                    prices[normalized(model)] = { ...price, source: price.source || `operator:${path}`, effectiveAt: price.effectiveAt || new Date().toISOString().slice(0, 10) }
                }
            }
        }
    } catch (error) {
        console.warn(`[Pricing] Ignoring invalid pricing file: ${error}`)
    }
    cached = prices
    return prices
}

export function resetModelPricingCache(): void {
    cached = null
}

function findPrice(provider: string, model: string): ModelPrice | null {
    const p = normalized(provider)
    const m = normalized(model)
    const entries = Object.entries(getModelPrices())
        // Exact aliases and dated snapshots only. A broad substring match made
        // e.g. gpt-5.4 silently inherit gpt-5 pricing, which is false evidence.
        .filter(([key]) => m === key || m.startsWith(`${key}-20`))
        .filter(([, value]) => !value.provider || normalized(value.provider) === p || !p)
        .sort(([a], [b]) => b.length - a.length)
    return entries[0]?.[1] || null
}

function isLocalProvider(provider: string, model: string, local?: boolean): boolean {
    if (local !== undefined) return local
    const value = `${provider} ${model}`.toLowerCase()
    return ['ollama', 'vllm', 'llama.cpp', 'llamacpp', 'local', 'internalmodel'].some(item => value.includes(item))
}

export function parseNvidiaPowerDraw(value: string): number {
    const first = String(value || '').split(/\r?\n/)[0]?.match(/\d+(?:[.,]\d+)?/)?.[0]
    const watts = Number(first?.replace(',', '.'))
    return Number.isFinite(watts) && watts > 0 ? watts : 0
}

function localPowerWatts(explicit?: number): { watts: number; source: string } {
    const configured = Number(explicit ?? process.env.NOVA_LOCAL_POWER_WATTS ?? 0)
    if (Number.isFinite(configured) && configured > 0) {
        return { watts: configured, source: 'operator energy/hardware configuration' }
    }
    if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
        || process.env.NOVA_AUTO_MEASURE_LOCAL_POWER === '0') {
        return { watts: 0, source: 'unpriced local runtime' }
    }
    try {
        const measured = spawnSync('nvidia-smi', [
            '--query-gpu=power.draw', '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', timeout: 2_000, windowsHide: true })
        const watts = measured.status === 0 ? parseNvidiaPowerDraw(measured.stdout) : 0
        if (watts > 0) return { watts, source: 'measured local GPU power via nvidia-smi' }
    } catch { /* non-NVIDIA and restricted nodes remain explicitly unpriced */ }
    return { watts: 0, source: 'unpriced local runtime' }
}

export function estimateUsageCost(input: {
    provider?: string
    model?: string
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    local?: boolean
    powerWatts?: number
}): UsageCostEstimate {
    const provider = input.provider || ''
    const model = input.model || ''
    const durationHours = Math.max(0, Number(input.durationMs || 0)) / 3_600_000
    const local = isLocalProvider(provider, model, input.local)
    const price = local ? null : findPrice(provider, model)
    const inputTokens = Math.max(0, Number(input.inputTokens || 0))
    const outputTokens = Math.max(0, Number(input.outputTokens || 0))
    const longContext54 = /^gpt-5\.4(?:$|-20|-pro)/i.test(model) && inputTokens > 272_000
    const cloudUsd = price
        ? (inputTokens * price.inputUsdPerMillion * (longContext54 ? 2 : 1)
            + outputTokens * price.outputUsdPerMillion * (longContext54 ? 1.5 : 1)) / 1_000_000
        : 0
    const measuredPower = localPowerWatts(input.powerWatts)
    const powerWatts = measuredPower.watts
    const energyUsdPerKwh = Math.max(0, Number(process.env.NOVA_ENERGY_USD_PER_KWH || 0.30))
    const hardwareUsdPerHour = Math.max(0, Number(process.env.NOVA_HARDWARE_USD_PER_HOUR || 0))
    const energyUsd = local ? (powerWatts / 1000) * durationHours * energyUsdPerKwh : 0
    const hardwareUsd = local ? durationHours * hardwareUsdPerHour : 0
    return {
        cloudUsd,
        energyUsd,
        hardwareUsd,
        totalUsd: cloudUsd + energyUsd + hardwareUsd,
        priced: Boolean(price) || (local && powerWatts > 0),
        estimated: local || !price,
        source: price?.source || (local ? measuredPower.source : 'unpriced model'),
    }
}
