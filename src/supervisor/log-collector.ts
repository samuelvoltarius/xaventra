/**
 * Log Collector for Supervisor
 * 
 * Watches Nova's log files in real-time and provides parsed log entries
 * for the Pattern Matcher to analyze.
 */

import { watch, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { LogEntry } from '../logging/structured-logger.js'

// ============================================
// Types
// ============================================

export interface CollectorConfig {
    logDir: string
    bufferSize: number  // Max entries to keep in memory
    watchInterval: number  // ms between file checks
}

export interface CollectorStats {
    totalEntriesProcessed: number
    errorsDetected: number
    warningsDetected: number
    bufferSize: number
    currentFile: string
    isWatching: boolean
}

// ============================================
// Log Collector
// ============================================

export class LogCollector extends EventEmitter {
    private config: CollectorConfig
    private buffer: LogEntry[] = []
    private filePosition: Map<string, number> = new Map()
    private watcher: ReturnType<typeof watch> | null = null
    private stats: CollectorStats
    private isWatching: boolean = false

    constructor(config: Partial<CollectorConfig> = {}) {
        super()
        this.config = {
            logDir: config.logDir || '.nova-logs',
            bufferSize: config.bufferSize || 1000,
            watchInterval: config.watchInterval || 1000,
        }

        this.stats = {
            totalEntriesProcessed: 0,
            errorsDetected: 0,
            warningsDetected: 0,
            bufferSize: 0,
            currentFile: '',
            isWatching: false,
        }
    }

    /**
     * Start watching log directory for changes
     */
    start(): void {
        if (this.isWatching) return

        console.log(`[LogCollector] Starting to watch: ${this.config.logDir}`)

        // Auto-create log directory if it doesn't exist
        if (!existsSync(this.config.logDir)) {
            mkdirSync(this.config.logDir, { recursive: true })
            console.log(`[LogCollector] Created directory: ${this.config.logDir}`)
        }

        // Initial read of existing logs
        this.readExistingLogs()

        // Watch for changes
        try {
            this.watcher = watch(this.config.logDir, { persistent: true }, (eventType, filename) => {
                if (filename && filename.endsWith('.jsonl')) {
                    this.processLogFile(join(this.config.logDir, filename))
                }
            })

            this.isWatching = true
            this.stats.isWatching = true
            console.log(`[LogCollector] ✅ Watching for log changes`)
        } catch (err) {
            console.error(`[LogCollector] ❌ Failed to watch directory:`, err)
        }
    }

    /**
     * Stop watching
     */
    stop(): void {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }
        this.isWatching = false
        this.stats.isWatching = false
        console.log(`[LogCollector] Stopped watching`)
    }

    /**
     * Read existing log files on startup
     */
    private readExistingLogs(): void {
        if (!existsSync(this.config.logDir)) return

        const files = readdirSync(this.config.logDir)
            .filter(f => f.endsWith('.jsonl'))
            .sort()

        // Only read today's log file
        const today = new Date().toISOString().split('T')[0]
        const todayFile = files.find(f => f.includes(today))

        if (todayFile) {
            this.processLogFile(join(this.config.logDir, todayFile))
        }
    }

    /**
     * Process a log file, reading only new entries
     */
    private processLogFile(filePath: string): void {
        if (!existsSync(filePath)) return

        const content = readFileSync(filePath, 'utf-8')
        const startPos = this.filePosition.get(filePath) || 0

        // Only process new content
        const newContent = content.slice(startPos)
        if (!newContent.trim()) return

        // Update position
        this.filePosition.set(filePath, content.length)
        this.stats.currentFile = filePath

        // Parse and process each line
        const lines = newContent.trim().split('\n')
        for (const line of lines) {
            if (!line.trim()) continue

            try {
                const entry = JSON.parse(line) as LogEntry
                this.processEntry(entry)
            } catch (err) {
                // Skip malformed lines
                console.warn(`[LogCollector] Malformed log line: ${line.slice(0, 50)}...`)
            }
        }
    }

    /**
     * Process a single log entry
     */
    private processEntry(entry: LogEntry): void {
        // Add to buffer
        this.buffer.push(entry)
        this.stats.totalEntriesProcessed++

        // Trim buffer if too large
        if (this.buffer.length > this.config.bufferSize) {
            this.buffer = this.buffer.slice(-this.config.bufferSize)
        }
        this.stats.bufferSize = this.buffer.length

        // Track errors and warnings
        if (entry.level === 'error' || entry.level === 'fatal') {
            this.stats.errorsDetected++
            this.emit('error', entry)
        } else if (entry.level === 'warn') {
            this.stats.warningsDetected++
            this.emit('warning', entry)
        }

        // Emit for all entries
        this.emit('entry', entry)
    }

    // ============================================
    // Query API
    // ============================================

    /**
     * Get recent log entries
     */
    getRecentEntries(count: number = 100): LogEntry[] {
        return this.buffer.slice(-count)
    }

    /**
     * Get errors from buffer
     */
    getErrors(): LogEntry[] {
        return this.buffer.filter(e => e.level === 'error' || e.level === 'fatal')
    }

    /**
     * Get entries by layer
     */
    getByLayer(layer: string): LogEntry[] {
        return this.buffer.filter(e => e.layer === layer)
    }

    /**
     * Search entries by message content
     */
    search(query: string): LogEntry[] {
        const lowerQuery = query.toLowerCase()
        return this.buffer.filter(e =>
            e.message.toLowerCase().includes(lowerQuery) ||
            JSON.stringify(e.metadata || {}).toLowerCase().includes(lowerQuery)
        )
    }

    /**
     * Get collector statistics
     */
    getStats(): CollectorStats {
        return { ...this.stats }
    }
}

// ============================================
// Singleton
// ============================================

let collector: LogCollector | null = null

export function getLogCollector(config?: Partial<CollectorConfig>): LogCollector {
    if (!collector) {
        collector = new LogCollector(config)
    }
    return collector
}

export default { LogCollector, getLogCollector }
