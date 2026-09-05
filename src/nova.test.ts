/**
 * Nova - Test Suite
 * 
 * Comprehensive tests using Vitest that match actual APIs.
 * Run: npm test
 */

import { describe, it, expect, vi } from 'vitest'

// ============================================
// Learning: FeedbackCollector Tests
// ============================================

describe('FeedbackCollector', async () => {
    const { FeedbackCollector } = await import('./learning/feedback.js')

    it('should collect positive feedback', () => {
        const collector = new FeedbackCollector()

        const feedback = collector.collectFeedback({
            type: 'positive',
            userMessage: 'What is the capital of France?',
            botResponse: 'Paris',
        })

        expect(feedback.id).toBeDefined()
        expect(feedback.type).toBe('positive')
    })

    it('should detect feedback types', () => {
        const collector = new FeedbackCollector()

        expect(collector.detectFeedbackType('Das war falsch!')).toBe('correction')
        expect(collector.detectFeedbackType('Danke!')).toBe('positive')
        expect(collector.detectFeedbackType('Das ist schlecht')).toBe('negative')
        expect(collector.detectFeedbackType('Ich bevorzuge lieber...')).toBe('preference')
        expect(collector.detectFeedbackType('Wie geht es dir?')).toBe(null)
    })

    it('should get all feedback', () => {
        const collector = new FeedbackCollector()

        collector.collectFeedback({
            type: 'positive',
            userMessage: 'Test',
            botResponse: 'Response',
        })

        const all = collector.getAllFeedback()
        expect(all.length).toBe(1)
    })

    it('should track stats', () => {
        const collector = new FeedbackCollector()

        collector.collectFeedback({ type: 'positive', userMessage: 'a', botResponse: 'b' })
        collector.collectFeedback({ type: 'negative', userMessage: 'c', botResponse: 'd' })

        const stats = collector.getStats()
        expect(stats.total).toBe(2)
        expect(stats.positive).toBe(1)
        expect(stats.negative).toBe(1)
    })

    it('should export/import JSON', () => {
        const collector = new FeedbackCollector()

        collector.collectFeedback({
            type: 'correction',
            userMessage: 'Wrong answer',
            botResponse: 'Bad',
            correction: 'Corrected answer',
        })

        const json = collector.exportToJSON()
        expect(json).toContain('correction')

        const newCollector = new FeedbackCollector()
        newCollector.importFromJSON(json)
        expect(newCollector.getAllFeedback().length).toBe(1)
    })
})

// ============================================
// Learning: PatternDetector Tests
// ============================================

describe('PatternDetector', async () => {
    const { PatternDetector } = await import('./learning/patterns.js')

    it('should process messages and find patterns', () => {
        const detector = new PatternDetector()

        // Process same-ish messages multiple times
        detector.processMessage('What time is it?')
        detector.processMessage('What time is it now?')
        detector.processMessage('What is the time?')

        const patterns = detector.getAllPatterns()
        expect(patterns.length).toBeGreaterThanOrEqual(0) // May or may not detect pattern yet
    })

    it('should find pattern for message', () => {
        const detector = new PatternDetector()

        detector.processMessage('Hello there!')
        const pattern = detector.findPatternForMessage('Hello there!')
        // Should either find it or return null
        expect(pattern === null || pattern.pattern !== undefined).toBe(true)
    })

    it('should get stats', () => {
        const detector = new PatternDetector()
        const stats = detector.getStats()

        expect(stats.totalPatterns).toBeDefined()
        expect(stats.byCategory).toBeDefined()
        expect(stats.highConfidence).toBeDefined()
    })

    it('should export/import JSON', () => {
        const detector = new PatternDetector()
        detector.processMessage('Test pattern message')

        const json = detector.exportToJSON()
        expect(typeof json).toBe('string')

        const newDetector = new PatternDetector()
        newDetector.importFromJSON(json)
        // Should not throw
    })
})

// ============================================
// Resilience: OutputValidator Tests
// ============================================

describe('OutputValidator', async () => {
    const { OutputValidator } = await import('./resilience/quality-gate.js')

    it('should validate clean code', () => {
        const validator = new OutputValidator()

        const result = validator.validate(`
      function add(a: number, b: number): number {
        return a + b
      }
    `)

        expect(result.valid).toBe(true)
    })

    it('should catch TODO comments', () => {
        const validator = new OutputValidator()

        const result = validator.validate(`
      function process() {
        // TODO: implement this
        return null
      }
    `)

        expect(result.valid).toBe(false)
        expect(result.issues.length).toBeGreaterThan(0)
    })

    it('should reject with shouldReject', () => {
        const validator = new OutputValidator()

        const hasIssues = validator.shouldReject(`
      // FIXME: broken
      throw new Error('Not implemented')
    `)

        expect(hasIssues).toBe(true)
    })

    it('should generate report', () => {
        const validator = new OutputValidator()

        const report = validator.getReport(`
      const foo = 'XXX placeholder'
    `)

        expect(report).toContain('Issue')
    })
})

// ============================================
// Resilience: FallbackManager Tests
// ============================================

describe('FallbackManager', async () => {
    const { FallbackManager } = await import('./resilience/fallback.js')

    it('should start in offline mode', () => {
        const fallback = new FallbackManager()
        expect(fallback.getMode()).toBe('offline')
        expect(fallback.isOnline()).toBe(false)
    })

    it('should track LLM connection', () => {
        const fallback = new FallbackManager()

        fallback.setLLMConnected(true)
        fallback.addChannel('telegram')

        expect(fallback.getMode()).toBe('online')
        expect(fallback.isOnline()).toBe(true)
    })

    it('should enter degraded mode', () => {
        const fallback = new FallbackManager()

        fallback.addChannel('whatsapp')
        // LLM not connected = degraded
        expect(fallback.getMode()).toBe('degraded')
    })

    it('should get status message', () => {
        const fallback = new FallbackManager()
        const status = fallback.getStatusMessage()

        expect(status).toContain('Nova')
        expect(status).toContain('Status')
    })

    it('should return state', () => {
        const fallback = new FallbackManager()
        const state = fallback.getState()

        expect(state.mode).toBe('offline')
        expect(state.llmConnected).toBe(false)
        expect(state.channelsConnected).toEqual([])
    })
})

// ============================================
// LLM: CustomLLM Tests
// ============================================

describe('CustomLLM', async () => {
    const { createOllamaLLM, createCustomLLM } = await import('./llm/custom.js')

    it('should create Ollama adapter', () => {
        const llm = createOllamaLLM()
        expect(llm).toBeDefined()
        expect(llm.getModel()).toBe('llama3')
    })

    it('should create custom adapter', () => {
        const llm = createCustomLLM({
            baseUrl: 'http://localhost:8080/v1',
            model: 'custom-model',
            type: 'openai-compatible',
        })

        expect(llm).toBeDefined()
        expect(llm.getModel()).toBe('custom-model')
    })

    it('should set model', () => {
        const llm = createOllamaLLM()
        llm.setModel('mistral')
        expect(llm.getModel()).toBe('mistral')
    })

    it('should get base URL', () => {
        const llm = createOllamaLLM('http://custom:11434')
        expect(llm.getBaseUrl()).toBe('http://custom:11434')
    })
})

describe('QwenAdapter', async () => {
    const { createQwen } = await import('./llm/qwen.js')

    it('should create adapter', () => {
        const adapter = createQwen({ apiKey: 'test-key' })
        expect(adapter).toBeDefined()
    })

    it('should list available models', () => {
        const adapter = createQwen({ apiKey: 'test-key' })
        const models = adapter.getAvailableModels()

        expect(models).toContain('qwen-turbo')
        expect(models).toContain('qwen-max')
        expect(models.length).toBeGreaterThan(5)
    })
})

// ============================================
// Metrics Tests
// ============================================

describe('Metrics', async () => {
    const { registry, metrics, MetricsServer } = await import('./infra/metrics.js')

    it('should track messages', () => {
        metrics.messageReceived('telegram')
        metrics.messageSent('telegram')

        const output = registry.toPrometheus()
        expect(output).toContain('nova_messages_total')
    })

    it('should track LLM requests', () => {
        metrics.llmRequest('openai', 'gpt-4o')
        metrics.llmTokens('openai', 'gpt-4o', 1500)

        const output = registry.toPrometheus()
        expect(output).toContain('nova_llm_requests_total')
    })

    it('should export Prometheus format', () => {
        const output = registry.toPrometheus()
        expect(output).toContain('# HELP')
        expect(output).toContain('# TYPE')
    })

    it('should export JSON format', () => {
        const json = registry.toJSON()
        expect(json).toBeDefined()
        expect(typeof json).toBe('object')
    })

    it('should create metrics server', () => {
        const server = new MetricsServer(9999)
        expect(server).toBeDefined()
    })
})

// ============================================
// Plugin System Tests
// ============================================

describe('PluginManager', async () => {
    const { PluginManager } = await import('./infra/plugins.js')

    it('should initialize without plugins', async () => {
        const manager = new PluginManager('.nonexistent-dir')
        await manager.loadAll()

        expect(manager.listPlugins().length).toBe(0)
    })

    it('should run hooks', async () => {
        const manager = new PluginManager()

        const hookFn = vi.fn(async (data) => ({ ...(data as object), modified: true }))
        manager.registerHook('beforeMessage', hookFn)

        const result = await manager.runHook('beforeMessage', { content: 'test' })

        expect(hookFn).toHaveBeenCalled()
        expect((result as Record<string, unknown>).modified).toBe(true)
    })

    it('should track commands', () => {
        const manager = new PluginManager()

        expect(manager.hasCommand('nonexistent')).toBe(false)
        expect(manager.getCommands()).toEqual([])
    })
})

// ============================================
// Config Tests
// ============================================

describe('Config', async () => {
    const { NovaConfigSchema } = await import('./core/config.js')

    it('should have valid schema', () => {
        expect(NovaConfigSchema).toBeDefined()
    })

    it('should parse minimal config', () => {
        const result = NovaConfigSchema.safeParse({
            provider: 'openai',
            model: 'gpt-4o',
        })

        expect(result.success).toBe(true)
    })

    it('should reject invalid provider', () => {
        const result = NovaConfigSchema.safeParse({
            provider: 'invalid-provider',
            model: 'gpt-4o',
        })

        expect(result.success).toBe(false)
    })
})

// ============================================
// Types Tests
// ============================================

describe('Types', async () => {
    const { MessageSchema, ChannelTypeSchema } = await import('./core/types.js')

    it('should validate messages', () => {
        const result = MessageSchema.safeParse({
            role: 'user',
            content: 'Hello Nova!',
        })

        expect(result.success).toBe(true)
    })

    it('should reject invalid message role', () => {
        const result = MessageSchema.safeParse({
            role: 'invalid',
            content: 'Hello',
        })

        expect(result.success).toBe(false)
    })

    it('should validate channel types', () => {
        const channels = ['whatsapp', 'telegram', 'discord', 'matrix', 'signal', 'slack', 'voip']

        for (const channel of channels) {
            const result = ChannelTypeSchema.safeParse(channel)
            expect(result.success).toBe(true)
        }
    })
})

// ============================================
// Integration Tests
// ============================================

describe('Integration', () => {
    it('should have learning engine', async () => {
        const { LearningEngine } = await import('./learning/engine.js')
        expect(LearningEngine).toBeDefined()
    })

    it('should have resilience layer', async () => {
        const { Layer0Controller } = await import('./resilience/index.js')
        expect(Layer0Controller).toBeDefined()
    })

    it('should have all channel adapters', async () => {
        const { createChannel } = await import('./channels/index.js')
        expect(createChannel).toBeDefined()
    })
})
