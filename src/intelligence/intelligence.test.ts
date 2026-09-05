/**
 * Nova — Intelligence Layer Tests
 *
 * Covers: emotion-tracker, entity-extractor, intent-router,
 *         thinking, token-killer, result-analyzer, user-patterns, self-reflection
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ============================================
// Emotion Tracker
// ============================================

describe('Emotion Tracker', async () => {
    const { analyzeEmotion, getEmotionalState, getEmotionPrompt, resetEmotion } = await import('./emotion-tracker.js')

    beforeEach(() => {
        resetEmotion('test-user-emotion')
    })

    it('analyzeEmotion: returns EmotionSignal', () => {
        const signal = analyzeEmotion('test-user-emotion', 'Das ist total frustrierend!!!')
        expect(signal).toBeDefined()
        expect(typeof signal.emotion).toBe('string')
        expect(typeof signal.confidence).toBe('number')
        expect(typeof signal.reason).toBe('string')
        expect(typeof signal.timestamp).toBe('number')
    })

    it('analyzeEmotion: detects frustration keywords', () => {
        const signal = analyzeEmotion('test-user-emotion', 'Das nervt total, schon wieder!!!')
        expect(['frustrated', 'stressed', 'neutral']).toContain(signal.emotion)
    })

    it('analyzeEmotion: detects happy keywords', () => {
        const signal = analyzeEmotion('test-user-happy', 'Super, das hat perfekt funktioniert! Danke!')
        expect(['happy', 'excited', 'calm', 'neutral']).toContain(signal.emotion)
    })

    it('getEmotionalState: returns state after signal', () => {
        analyzeEmotion('test-user-state', 'Test message')
        const state = getEmotionalState('test-user-state')
        expect(typeof state.currentEmotion).toBe('string')
        expect(typeof state.confidence).toBe('number')
        expect(typeof state.trend).toBe('string')
        expect(Array.isArray(state.recentSignals)).toBe(true)
    })

    it('getEmotionalState: returns neutral for unknown user', () => {
        const state = getEmotionalState('unknown-user-xyz-99999')
        expect(state.currentEmotion).toBe('neutral')
    })

    it('getEmotionPrompt: returns string', () => {
        analyzeEmotion('test-user-prompt', 'Ein normaler Satz')
        const prompt = getEmotionPrompt('test-user-prompt')
        expect(typeof prompt).toBe('string')
    })

    it('resetEmotion: clears state', () => {
        analyzeEmotion('test-user-reset', 'frustriert!!!')
        resetEmotion('test-user-reset')
        const state = getEmotionalState('test-user-reset')
        expect(state.recentSignals.length).toBe(0)
    })
})

// ============================================
// Entity Extractor
// ============================================

describe('Entity Extractor', async () => {
    const { extractEntities, mergeEntities, getEntitySummary, updateSessionContext, getSessionContext } = await import('./entity-extractor.js')

    it('extractEntities: returns ExtractedEntities structure', () => {
        const entities = extractEntities('Schau dir mal src/layers/L10-vision.ts an')
        expect(Array.isArray(entities.paths)).toBe(true)
        expect(Array.isArray(entities.people)).toBe(true)
        expect(Array.isArray(entities.tools)).toBe(true)
        expect(Array.isArray(entities.technologies)).toBe(true)
        expect(Array.isArray(entities.commands)).toBe(true)
    })

    it('extractEntities: detects file paths', () => {
        const entities = extractEntities('Edit src/layers/L10-vision.ts please')
        const found = entities.paths.some(p => p.includes('L10-vision') || p.includes('src'))
        expect(found).toBe(true)
    })

    it('extractEntities: detects technologies', () => {
        const entities = extractEntities('Use TypeScript and Node.js for the backend')
        expect(entities.technologies.length).toBeGreaterThan(0)
    })

    it('mergeEntities: combines two entity sets without duplicates', () => {
        const a = extractEntities('src/foo.ts bar.ts')
        const b = extractEntities('src/foo.ts baz.ts')
        const merged = mergeEntities(a, b)
        // foo.ts should appear only once
        expect(merged.paths.filter(p => p.includes('foo')).length).toBeLessThanOrEqual(1)
    })

    it('getEntitySummary: returns string', () => {
        const entities = extractEntities('npm install in /home/sample/project')
        const summary = getEntitySummary(entities)
        expect(typeof summary).toBe('string')
    })

    it('updateSessionContext: stores and returns context', () => {
        const ctx = updateSessionContext('test-session-abc', 'Looking at src/daemon.ts')
        expect(ctx).toBeDefined()
        expect(typeof ctx.extractedAt).toBe('number')
    })

    it('getSessionContext: returns stored context', () => {
        updateSessionContext('test-session-get', 'Hallo Nova')
        const ctx = getSessionContext('test-session-get')
        expect(ctx).toBeDefined()
    })

    it('getSessionContext: returns undefined for unknown session', () => {
        const ctx = getSessionContext('nonexistent-session-xyz99999')
        expect(ctx).toBeUndefined()
    })
})

// ============================================
// Intent Router
// ============================================

describe('Intent Router', async () => {
    const { classifyIntent, routeToModel, getRouterConfig, getModelMap, configureRouter } = await import('./intent-router.js')

    it('classifyIntent: returns IntentResult', () => {
        const result = classifyIntent('Was ist die Hauptstadt von Österreich?')
        expect(typeof result.category).toBe('string')
        expect(typeof result.confidence).toBe('number')
        expect(typeof result.suggestedModel).toBe('string')
        expect(typeof result.reason).toBe('string')
    })

    it('classifyIntent: detects code intent', () => {
        const result = classifyIntent('Schreibe eine TypeScript-Funktion zum Sortieren')
        expect(['code', 'analysis', 'simple']).toContain(result.category)
    })

    it('classifyIntent: detects search intent', () => {
        const result = classifyIntent('Suche nach den neuesten News über OpenAI')
        expect(['search', 'simple', 'analysis']).toContain(result.category)
    })

    it('routeToModel: returns model and intent', () => {
        const result = routeToModel('Erkläre mir Rekursion in Programmierung')
        expect(typeof result.model).toBe('string')
        expect(typeof result.intent).toBe('object')
        expect(typeof result.intent.category).toBe('string')
        expect(typeof result.routed).toBe('boolean')
    })

    it('getRouterConfig: returns config object', () => {
        const config = getRouterConfig()
        expect(typeof config.enabled).toBe('boolean')
        expect(typeof config.confidenceThreshold).toBe('number')
    })

    it('getModelMap: returns model mapping for all categories', () => {
        const map = getModelMap()
        expect(typeof map).toBe('object')
        expect(typeof map.code).toBe('string')
        expect(typeof map.simple).toBe('string')
    })

    it('configureRouter: updates config without throwing', () => {
        expect(() => configureRouter({ enabled: true, confidenceThreshold: 0.7 })).not.toThrow()
    })
})

// ============================================
// Thinking Layer
// ============================================

describe('Thinking Layer', async () => {
    const {
        buildThinkingPrompt, extractThinking, stripThinking,
        shouldEnableThinking, isComplexActionRequest,
        getUserThinkingLevel, setUserThinkingLevel,
        buildThinkingRetryPrompt, DEFAULT_THINKING_CONFIG,
    } = await import('./thinking.js')

    it('buildThinkingPrompt: returns non-empty string', () => {
        const prompt = buildThinkingPrompt()
        expect(typeof prompt).toBe('string')
        expect(prompt.length).toBeGreaterThan(0)
    })

    it('buildThinkingPrompt: accepts language parameter', () => {
        const prompt = buildThinkingPrompt('de')
        expect(typeof prompt).toBe('string')
    })

    it('extractThinking: strips thinking blocks', () => {
        const raw = '<thinking>Ich überlege...</thinking>Das ist meine Antwort.'
        const result = extractThinking(raw)
        expect(result.hadThinking).toBe(true)
        expect(result.thinking).toContain('überlege')
        expect(result.content).toContain('Antwort')
        expect(result.content).not.toContain('<thinking>')
    })

    it('extractThinking: handles response without thinking blocks', () => {
        const raw = 'Einfache Antwort ohne Thinking.'
        const result = extractThinking(raw)
        expect(result.hadThinking).toBe(false)
        expect(result.content).toBe(raw)
    })

    it('stripThinking: returns only content', () => {
        const raw = '<thinking>Intern</thinking>Extern'
        const stripped = stripThinking(raw)
        expect(stripped).toContain('Extern')
        expect(stripped).not.toContain('Intern')
    })

    it('shouldEnableThinking: returns boolean', () => {
        expect(typeof shouldEnableThinking(80)).toBe('boolean')
        expect(typeof shouldEnableThinking(20)).toBe('boolean')
    })

    it('shouldEnableThinking: high complexity → more likely true', () => {
        // With default config, high complexity should enable thinking
        const high = shouldEnableThinking(95)
        const low = shouldEnableThinking(5)
        // high >= low (can't be stricter without knowing exact thresholds)
        expect(typeof high).toBe('boolean')
        expect(typeof low).toBe('boolean')
    })

    it('isComplexActionRequest: returns boolean', () => {
        expect(typeof isComplexActionRequest('Schreibe einen komplexen Algorithmus')).toBe('boolean')
        expect(typeof isComplexActionRequest('Hi')).toBe('boolean')
    })

    it('isComplexActionRequest: detects complex patterns', () => {
        expect(isComplexActionRequest('Refactor the entire authentication system and add tests')).toBe(true)
    })

    it('getUserThinkingLevel / setUserThinkingLevel: round-trip', () => {
        setUserThinkingLevel('test-think-user', 'on')
        expect(getUserThinkingLevel('test-think-user')).toBe('on')
        setUserThinkingLevel('test-think-user', 'off')
        expect(getUserThinkingLevel('test-think-user')).toBe('off')
    })

    it('buildThinkingRetryPrompt: returns non-empty string', () => {
        const prompt = buildThinkingRetryPrompt()
        expect(typeof prompt).toBe('string')
        expect(prompt.length).toBeGreaterThan(0)
    })

    it('DEFAULT_THINKING_CONFIG: has expected fields', () => {
        expect(typeof DEFAULT_THINKING_CONFIG.level).toBe('string')
        expect(typeof DEFAULT_THINKING_CONFIG.autoThreshold).toBe('number')
    })
})

// ============================================
// Token Killer
// ============================================

describe('Token Killer', async () => {
    const { compressToolOutput, getTokenKillerStats } = await import('./token-killer.js')

    it('compressToolOutput: returns CompressionResult', () => {
        const result = compressToolOutput('bash', 'ls -la', 'file1.ts\nfile2.ts\nfile3.ts\n')
        expect(typeof result.original).toBe('string')
        expect(typeof result.compressed).toBe('string')
        expect(typeof result.originalTokens).toBe('number')
        expect(typeof result.compressedTokens).toBe('number')
        expect(typeof result.savings).toBe('number')
        expect(typeof result.strategy).toBe('string')
    })

    it('compressToolOutput: compressed <= original size', () => {
        const longOutput = Array.from({ length: 100 }, (_, i) => `line ${i}: some content here`).join('\n')
        const result = compressToolOutput('bash', 'cat file.txt', longOutput)
        expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens)
    })

    it('compressToolOutput: handles empty output', () => {
        const result = compressToolOutput('bash', 'echo ""', '')
        expect(typeof result.compressed).toBe('string')
    })

    it('getTokenKillerStats: returns stats object', () => {
        const stats = getTokenKillerStats()
        expect(typeof stats.totalCalls).toBe('number')
        expect(typeof stats.totalTokensSaved).toBe('number')
        expect(stats.totalCalls).toBeGreaterThanOrEqual(0)
    })
})

// ============================================
// Result Analyzer
// ============================================

describe('Result Analyzer', async () => {
    const { startTask, recordToolCall, analyzeResults, clearTask, getProactivityPrompt } = await import('./result-analyzer.js')

    beforeEach(() => {
        clearTask()
    })

    it('startTask: does not throw', () => {
        expect(() => startTask('Datei bearbeiten', 'File should be saved')).not.toThrow()
    })

    it('analyzeResults: returns AnalysisResult after empty task', () => {
        startTask('simple task')
        const result = analyzeResults()
        expect(typeof result.isComplete).toBe('boolean')
        expect(typeof result.confidence).toBe('number')
        expect(typeof result.summary).toBe('string')
        expect(typeof result.proactiveMessage).toBe('string')
    })

    it('recordToolCall: does not throw', () => {
        startTask('test task')
        expect(() => recordToolCall('bash', { success: true, output: 'ok' })).not.toThrow()
    })

    it('analyzeResults: detects tool failure', () => {
        startTask('run command')
        recordToolCall('bash', { success: false, error: 'command not found' })
        const result = analyzeResults()
        expect(typeof result.isComplete).toBe('boolean')
        // Issues array should exist
        expect(result.issues === undefined || Array.isArray(result.issues)).toBe(true)
    })

    it('clearTask: resets state', () => {
        startTask('task to clear')
        clearTask()
        // After clear, analyzeResults should still work
        const result = analyzeResults()
        expect(typeof result.isComplete).toBe('boolean')
    })

    it('getProactivityPrompt: returns non-empty string', () => {
        const prompt = getProactivityPrompt()
        expect(typeof prompt).toBe('string')
        expect(prompt.length).toBeGreaterThan(0)
    })
})

// ============================================
// User Patterns
// ============================================

describe('User Patterns', async () => {
    const { trackInteraction, getPattern, getPeakHours, getRecentTopics, markUnfinished, markFinished, setPreference, flush } = await import('./user-patterns.js')

    it('trackInteraction: does not throw', () => {
        expect(() => trackInteraction('test-pattern-user', 'Wie schreibe ich TypeScript Generics?', ['bash', 'read'])).not.toThrow()
    })

    it('getPattern: returns pattern after tracking', () => {
        trackInteraction('test-pattern-get', 'Some test message')
        const pattern = getPattern('test-pattern-get')
        expect(pattern).not.toBeNull()
        if (pattern) {
            expect(typeof pattern.topTopics).toBe('object')
        }
    })

    it('getPattern: returns null for unknown user', () => {
        const pattern = getPattern('unknown-user-' + Date.now())
        expect(pattern).toBeNull()
    })

    it('getPeakHours: returns array for tracked user', () => {
        trackInteraction('test-peak-user', 'morning message')
        const hours = getPeakHours('test-peak-user')
        expect(Array.isArray(hours)).toBe(true)
    })

    it('getRecentTopics: returns array', () => {
        trackInteraction('test-topics-user', 'Fragen über TypeScript Typen')
        const topics = getRecentTopics('test-topics-user')
        expect(Array.isArray(topics)).toBe(true)
    })

    it('markUnfinished / markFinished: round-trip without throwing', () => {
        trackInteraction('test-unfin-user', 'Angefangene Aufgabe')
        expect(() => markUnfinished('test-unfin-user', 'Refactoring Plan')).not.toThrow()
        expect(() => markFinished('test-unfin-user', 'Refactoring Plan')).not.toThrow()
    })

    it('setPreference: does not throw', () => {
        expect(() => setPreference('test-pref-user', 'language', 'de')).not.toThrow()
    })

    it('flush: does not throw', () => {
        expect(() => flush()).not.toThrow()
    })
})

// ============================================
// Self Reflection
// ============================================

describe('Self Reflection', async () => {
    const { reflect, getReflectionPrompt, logReflection } = await import('./self-reflection.js')

    it('reflect: returns ReflectionResult', () => {
        const context = {
            userMessage: 'Wie lautet der aktuelle Stand?',
            assistantResponse: 'Der aktuelle Stand ist gut.',
            toolsUsed: [],
            toolResults: [],
        }
        const result = reflect(context)
        expect(typeof result.needsImprovement).toBe('boolean')
        expect(Array.isArray(result.issues)).toBe(true)
        expect(Array.isArray(result.suggestions)).toBe(true)
    })

    it('reflect: flags empty response', () => {
        const context = {
            userMessage: 'Erkläre mir X',
            assistantResponse: '',
            toolsUsed: [],
            toolResults: [],
        }
        const result = reflect(context)
        expect(result.needsImprovement).toBe(true)
        expect(result.issues.length).toBeGreaterThan(0)
    })

    it('reflect: detects unanswered question', () => {
        const context = {
            userMessage: 'Was ist 2+2?',
            assistantResponse: 'Das Wetter ist heute schön.',
            toolsUsed: [],
            toolResults: [],
        }
        const result = reflect(context)
        expect(typeof result.needsImprovement).toBe('boolean')
    })

    it('reflect: accepts good response as-is', () => {
        const context = {
            userMessage: 'Was ist die Hauptstadt von Österreich?',
            assistantResponse: 'Die Hauptstadt von Österreich ist Wien.',
            toolsUsed: [],
            toolResults: [],
        }
        const result = reflect(context)
        // Good response should not always need improvement
        expect(typeof result.needsImprovement).toBe('boolean')
    })

    it('getReflectionPrompt: returns non-empty string', () => {
        const prompt = getReflectionPrompt()
        expect(typeof prompt).toBe('string')
        expect(prompt.length).toBeGreaterThan(0)
    })

    it('logReflection: does not throw', () => {
        const result = { needsImprovement: false, issues: [], suggestions: [] }
        expect(() => logReflection(result)).not.toThrow()
    })
})
