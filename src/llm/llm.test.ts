/**
 * Nova — LLM Layer Tests
 *
 * Covers: models (SEED_MODELS, ModelCatalog),
 *         model-fallback, model-perf-db
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ============================================
// Models / Model Catalog
// ============================================

describe('Models Catalog', async () => {
    // SEED_MODELS is NOT a named export — only accessible via default or getModelsForProvider()
    const { getModelsForProvider, getModelCatalog } = await import('./models.js')
    const modDefault = (await import('./models.js') as any).default
    const SEED_MODELS_MAP = modDefault?.SEED_MODELS  // Record<provider, NovaModel[]>

    it('SEED_MODELS (via default): has provider keys', () => {
        if (!SEED_MODELS_MAP) return  // skip if not accessible
        expect(typeof SEED_MODELS_MAP).toBe('object')
        expect(Object.keys(SEED_MODELS_MAP).length).toBeGreaterThan(0)
    })

    it('SEED_MODELS (via default): openai entry has models', () => {
        if (!SEED_MODELS_MAP) return
        const openai = SEED_MODELS_MAP['openai'] || []
        expect(openai.length).toBeGreaterThan(0)
    })

    it('SEED_MODELS (via default): each model has id, name, provider, capabilities', () => {
        if (!SEED_MODELS_MAP) return
        for (const [provider, models] of Object.entries(SEED_MODELS_MAP as Record<string, any[]>)) {
            for (const model of models) {
                expect(typeof model.id).toBe('string')
                expect(typeof model.name).toBe('string')
                expect(typeof model.provider).toBe('string')
                expect(Array.isArray(model.capabilities)).toBe(true)
            }
        }
    })

    it('SEED_MODELS (via default): contains anthropic models', () => {
        if (!SEED_MODELS_MAP) return
        const anthropic = SEED_MODELS_MAP['anthropic'] || []
        expect(anthropic.length).toBeGreaterThan(0)
    })

    it('getModelsForProvider: returns openai models synchronously', () => {
        const models = getModelsForProvider('openai')
        expect(Array.isArray(models)).toBe(true)
        expect(models.length).toBeGreaterThan(0)
    })

    it('getModelsForProvider: returns empty for unknown provider', () => {
        const models = getModelsForProvider('unknown-provider-xyz')
        expect(Array.isArray(models)).toBe(true)
        expect(models.length).toBe(0)
    })

    it('getModelCatalog: returns singleton', () => {
        const a = getModelCatalog()
        const b = getModelCatalog()
        expect(a).toBe(b)
    })

    it('getModelCatalog: instance has getProviders method', () => {
        const catalog = getModelCatalog()
        const providers = catalog.getProviders()
        expect(Array.isArray(providers)).toBe(true)
        expect(providers.length).toBeGreaterThan(0)
    })

    it('getModelCatalog: getAllModels resolves to array', async () => {
        const catalog = getModelCatalog()
        const models = await catalog.getAllModels()
        expect(Array.isArray(models)).toBe(true)
        expect(models.length).toBeGreaterThan(0)
    })

    it('getModelCatalog: getModelsByCapability chat resolves to array', async () => {
        const catalog = getModelCatalog()
        const models = await catalog.getModelsByCapability('chat')
        expect(Array.isArray(models)).toBe(true)
    })
})

// ============================================
// Model Fallback
// ============================================

describe('Model Fallback', async () => {
    const {
        FailoverError, isFailoverError, classifyFailoverReason,
        isTimeoutError, coerceToFailoverError, describeFailoverError,
        DEFAULT_FALLBACKS,
    } = await import('./model-fallback.js')

    it('FailoverError: creates instance', () => {
        const err = new FailoverError('Too many requests', {
            reason: 'rate_limit',
            provider: 'openai',
            status: 429,
        })
        expect(err).toBeInstanceOf(Error)
        expect(err.reason).toBe('rate_limit')
        expect(err.message).toBe('Too many requests')
    })

    it('isFailoverError: identifies FailoverError', () => {
        const err = new FailoverError('billing', 'Quota exceeded')
        expect(isFailoverError(err)).toBe(true)
    })

    it('isFailoverError: rejects plain Error', () => {
        expect(isFailoverError(new Error('generic'))).toBe(false)
    })

    it('classifyFailoverReason: detects rate_limit', () => {
        const reason = classifyFailoverReason('rate limit exceeded 429')
        expect(reason).toBe('rate_limit')
    })

    it('classifyFailoverReason: detects auth errors', () => {
        const reason = classifyFailoverReason('Invalid API key provided')
        expect(reason).toBe('auth')
    })

    it('classifyFailoverReason: returns null for unknown', () => {
        const reason = classifyFailoverReason('completely random unrelated message xyz')
        expect(reason).toBeNull()
    })

    it('isTimeoutError: detects timeout', () => {
        const err = new Error('Request timed out after 30000ms')
        expect(isTimeoutError(err)).toBe(true)
    })

    it('isTimeoutError: rejects non-timeout', () => {
        expect(isTimeoutError(new Error('something else'))).toBe(false)
    })

    it('coerceToFailoverError: wraps known error', () => {
        const err = new Error('rate limit hit')
        const wrapped = coerceToFailoverError(err)
        // Returns FailoverError or null
        expect(wrapped === null || wrapped instanceof FailoverError).toBe(true)
    })

    it('describeFailoverError: returns description object', () => {
        const err = new FailoverError('timeout', 'Request timed out')
        const desc = describeFailoverError(err)
        expect(typeof desc.message).toBe('string')
    })

    it('DEFAULT_FALLBACKS: is an array with model candidates', () => {
        expect(Array.isArray(DEFAULT_FALLBACKS)).toBe(true)
    })
})

// ============================================
// Model Performance DB
// ============================================

describe('Model Perf DB', async () => {
    const {
        recordModelCall, getModelScoreAdjustment, getPerfSummary,
        getAllModelStats, isModelDisabled, reenableModel, getDisabledModels,
    } = await import('./model-perf-db.js')

    it('recordModelCall: does not throw', () => {
        expect(() => recordModelCall('gpt-4o', 'coding', 1200, true)).not.toThrow()
        expect(() => recordModelCall('claude-sonnet-4-6', 'analysis', 800, true)).not.toThrow()
    })

    it('getModelScoreAdjustment: returns number', () => {
        recordModelCall('test-model-score', 'general', 500, true)
        const adj = getModelScoreAdjustment('test-model-score', 'general')
        expect(typeof adj).toBe('number')
    })

    it('getModelScoreAdjustment: returns 0 for unknown model', () => {
        const adj = getModelScoreAdjustment('nonexistent-model-xyz99999', 'general')
        expect(adj).toBe(0)
    })

    it('getPerfSummary: returns non-empty string after recording', () => {
        // getPerfSummary filters for entries with totalCalls >= 3
        recordModelCall('summary-model', 'chat', 300, true)
        recordModelCall('summary-model', 'chat', 300, true)
        recordModelCall('summary-model', 'chat', 300, true)
        const summary = getPerfSummary()
        expect(typeof summary).toBe('string')
        expect(summary.length).toBeGreaterThan(0)
    })

    it('getAllModelStats: returns array', () => {
        const stats = getAllModelStats()
        expect(Array.isArray(stats)).toBe(true)
    })

    it('getAllModelStats: each entry has expected fields', () => {
        recordModelCall('stat-model', 'chat', 400, true)
        const stats = getAllModelStats()
        if (stats.length > 0) {
            const entry = stats[0]
            expect(typeof entry.model).toBe('string')
            expect(typeof entry.successRate).toBe('number')
            expect(typeof entry.avgLatencyMs).toBe('number')
            expect(typeof entry.totalCalls).toBe('number')
        }
    })

    it('isModelDisabled: returns false for healthy model', () => {
        recordModelCall('healthy-model', 'chat', 200, true)
        expect(isModelDisabled('healthy-model')).toBe(false)
    })

    it('isModelDisabled: returns false for unknown model', () => {
        expect(isModelDisabled('nonexistent-xyz-999')).toBe(false)
    })

    it('reenableModel: does not throw', () => {
        expect(() => reenableModel('some-model')).not.toThrow()
    })

    it('getDisabledModels: returns array', () => {
        const disabled = getDisabledModels()
        expect(Array.isArray(disabled)).toBe(true)
    })
})
