/**
 * Supervisor Module Exports
 */

export { getLogger, createLayerLogger, type LogEntry, type LogLevel } from '../logging/structured-logger.js'
export { getLogCollector, LogCollector, type CollectorStats } from './log-collector.js'
export { getPatternMatcher, PatternMatcher, type ErrorPattern, type PatternMatch, type PatternStats } from './pattern-matcher.js'
export { getFixGenerator, FixGenerator, type FixProposal, type FileChange } from './fix-generator.js'
export { getAutoTester, AutoTester, type TestResult } from './auto-tester.js'
export { getSupervisor, SupervisorManager, type SupervisorConfig, type SupervisorStats } from './supervisor-manager.js'
export { getCircuitBreaker, CircuitBreaker, type CircuitState, type CircuitConfig } from './circuit-breaker.js'

