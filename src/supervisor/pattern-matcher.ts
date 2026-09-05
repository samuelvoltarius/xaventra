/**
 * Pattern Matcher for Supervisor
 * 
 * Detects known error patterns, tracks frequency, and identifies
 * correlations between different errors.
 */

import { EventEmitter } from 'node:events'
import { LogEntry } from '../logging/structured-logger.js'

// ============================================
// Types
// ============================================

export interface ErrorPattern {
    id: string
    name: string
    description: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    // Match criteria
    layerMatch?: string | RegExp
    messageMatch: string | RegExp
    metadataMatch?: Record<string, unknown>
    // Fix hint for the generator
    fixHint?: string
    // Auto-fixable?
    autoFixable: boolean
}

export interface PatternMatch {
    pattern: ErrorPattern
    entry: LogEntry
    timestamp: Date
    context: LogEntry[]  // Surrounding log entries for context
}

export interface PatternStats {
    patternId: string
    count: number
    lastSeen: Date
    firstSeen: Date
    avgIntervalMs?: number
}

// ============================================
// Known Error Patterns
// ============================================

const KNOWN_PATTERNS: ErrorPattern[] = [
    {
        id: 'script_not_found',
        name: 'Script Not Found',
        description: 'Trying to execute a script that does not exist',
        severity: 'medium',
        messageMatch: /Script fehlt|Cannot find module|ENOENT.*\.js|\.ts/i,
        fixHint: 'Create the missing script file or fix the path',
        autoFixable: true,
    },
    {
        id: 'npm_package_missing',
        name: 'NPM Package Missing',
        description: 'Required npm package is not installed',
        severity: 'medium',
        messageMatch: /Cannot find module|MODULE_NOT_FOUND|is not recognized/i,
        fixHint: 'Install the missing npm package',
        autoFixable: true,
    },
    {
        id: 'python_not_found',
        name: 'Python Not Found',
        description: 'Python or pip not in PATH',
        severity: 'high',
        messageMatch: /python.*not found|pip.*not found|where python/i,
        fixHint: 'Add Python to PATH or use full path to python.exe',
        autoFixable: true,
    },
    {
        id: 'api_key_missing',
        name: 'API Key Missing',
        description: 'Required API key is not configured',
        severity: 'high',
        messageMatch: /API key.*missing|no.*key.*configured|unauthorized/i,
        fixHint: 'Configure the missing API key in xaventra.config.json',
        autoFixable: false,
    },
    {
        id: 'type_error',
        name: 'TypeScript Type Error',
        description: 'TypeScript compilation error',
        severity: 'high',
        messageMatch: /TS\d{4}:|Type.*is not assignable|Property.*does not exist/i,
        fixHint: 'Fix the TypeScript type error',
        autoFixable: true,
    },
    {
        id: 'timeout',
        name: 'Operation Timeout',
        description: 'An operation timed out',
        severity: 'medium',
        messageMatch: /timeout|timed out|ETIMEDOUT/i,
        fixHint: 'Increase timeout or check network connectivity',
        autoFixable: false,
    },
    {
        id: 'permission_denied',
        name: 'Permission Denied',
        description: 'Insufficient permissions for operation',
        severity: 'high',
        messageMatch: /permission denied|EACCES|access denied/i,
        fixHint: 'Check file permissions or run with elevated privileges',
        autoFixable: false,
    },
    {
        id: 'connection_refused',
        name: 'Connection Refused',
        description: 'Could not connect to a service',
        severity: 'medium',
        messageMatch: /ECONNREFUSED|connection refused|connect failed/i,
        fixHint: 'Check if the service is running and accessible',
        autoFixable: false,
    },
    {
        id: 'syntax_error',
        name: 'Syntax Error',
        description: 'JavaScript/TypeScript syntax error',
        severity: 'critical',
        messageMatch: /SyntaxError|Unexpected token|Parse error/i,
        fixHint: 'Fix the syntax error in the code',
        autoFixable: true,
    },
    {
        id: 'llm_error',
        name: 'LLM Provider Error',
        description: 'Error from LLM provider (rate limit, etc)',
        severity: 'high',
        messageMatch: /rate limit|quota exceeded|429|503.*unavailable/i,
        fixHint: 'Wait and retry, or switch to backup provider',
        autoFixable: false,
    },
]

// ============================================
// Pattern Matcher
// ============================================

export class PatternMatcher extends EventEmitter {
    private patterns: ErrorPattern[]
    private stats: Map<string, PatternStats> = new Map()
    private recentMatches: PatternMatch[] = []
    private maxMatchHistory: number = 100

    constructor(customPatterns: ErrorPattern[] = []) {
        super()
        this.patterns = [...KNOWN_PATTERNS, ...customPatterns]
        console.log(`[PatternMatcher] Initialized with ${this.patterns.length} patterns`)
    }

    /**
     * Check a log entry against all patterns
     */
    match(entry: LogEntry, context: LogEntry[] = []): PatternMatch | null {
        // Only match errors and warnings
        if (entry.level !== 'error' && entry.level !== 'warn' && entry.level !== 'fatal') {
            return null
        }

        for (const pattern of this.patterns) {
            if (this.matchesPattern(entry, pattern)) {
                const match: PatternMatch = {
                    pattern,
                    entry,
                    timestamp: new Date(),
                    context,
                }

                // Update stats
                this.updateStats(pattern.id)

                // Store match
                this.recentMatches.push(match)
                if (this.recentMatches.length > this.maxMatchHistory) {
                    this.recentMatches = this.recentMatches.slice(-this.maxMatchHistory)
                }

                // Emit event
                this.emit('match', match)

                console.log(`[PatternMatcher] 🎯 Matched: ${pattern.name} (${pattern.severity})`)
                return match
            }
        }

        return null
    }

    /**
     * Check if entry matches a specific pattern
     */
    private matchesPattern(entry: LogEntry, pattern: ErrorPattern): boolean {
        // Check layer match
        if (pattern.layerMatch) {
            const layerRegex = pattern.layerMatch instanceof RegExp
                ? pattern.layerMatch
                : new RegExp(pattern.layerMatch, 'i')
            if (!layerRegex.test(entry.layer)) {
                return false
            }
        }

        // Check message match
        const messageRegex = pattern.messageMatch instanceof RegExp
            ? pattern.messageMatch
            : new RegExp(pattern.messageMatch, 'i')

        const fullMessage = entry.message + (entry.error?.message || '') + JSON.stringify(entry.metadata || {})
        if (!messageRegex.test(fullMessage)) {
            return false
        }

        return true
    }

    /**
     * Update pattern statistics
     */
    private updateStats(patternId: string): void {
        const now = new Date()
        const existing = this.stats.get(patternId)

        if (existing) {
            const interval = now.getTime() - existing.lastSeen.getTime()
            const newAvg = existing.avgIntervalMs
                ? (existing.avgIntervalMs + interval) / 2
                : interval

            this.stats.set(patternId, {
                ...existing,
                count: existing.count + 1,
                lastSeen: now,
                avgIntervalMs: newAvg,
            })
        } else {
            this.stats.set(patternId, {
                patternId,
                count: 1,
                firstSeen: now,
                lastSeen: now,
            })
        }
    }

    // ============================================
    // Query API
    // ============================================

    /**
     * Get all pattern statistics
     */
    getStats(): PatternStats[] {
        return Array.from(this.stats.values())
            .sort((a, b) => b.count - a.count)
    }

    /**
     * Get recent matches
     */
    getRecentMatches(count: number = 20): PatternMatch[] {
        return this.recentMatches.slice(-count)
    }

    /**
     * Get patterns by severity
     */
    getCriticalPatterns(): PatternStats[] {
        return this.getStats().filter(s => {
            const pattern = this.patterns.find(p => p.id === s.patternId)
            return pattern?.severity === 'critical' || pattern?.severity === 'high'
        })
    }

    /**
     * Get auto-fixable patterns that have occurred
     */
    getAutoFixableMatches(): PatternMatch[] {
        return this.recentMatches.filter(m => m.pattern.autoFixable)
    }

    /**
     * Add custom pattern at runtime
     */
    addPattern(pattern: ErrorPattern): void {
        this.patterns.push(pattern)
        console.log(`[PatternMatcher] Added pattern: ${pattern.name}`)
    }

    /**
     * Get all registered patterns
     */
    getPatterns(): ErrorPattern[] {
        return [...this.patterns]
    }
}

// ============================================
// Singleton
// ============================================

let matcher: PatternMatcher | null = null

export function getPatternMatcher(): PatternMatcher {
    if (!matcher) {
        matcher = new PatternMatcher()
    }
    return matcher
}

export default { PatternMatcher, getPatternMatcher, KNOWN_PATTERNS }
