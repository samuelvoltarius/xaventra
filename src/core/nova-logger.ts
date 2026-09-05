/**
 * Nova Structured Logger
 * 
 * Drop-in replacement for console.log with:
 * - Log levels (debug/info/warn/error)
 * - ISO timestamps
 * - File rotation (daily, keep 7 days)
 * - Global console.log override for zero-migration
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
}

// ============================================
// Config
// ============================================

const LOG_DIR = join(process.cwd(), 'logs')
const MAX_LOG_DAYS = 7
const MIN_LEVEL = (process.env.LOG_LEVEL as LogLevel) || 'info'

// ============================================
// Logger Class
// ============================================

class NovaLogger {
    private currentDate = ''
    private logFile = ''

    constructor() {
        this.ensureLogDir()
        this.rotateIfNeeded()
    }

    private ensureLogDir(): void {
        try {
            if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
        } catch { /* non-critical */ }
    }

    private rotateIfNeeded(): void {
        const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD
        if (today !== this.currentDate) {
            this.currentDate = today
            this.logFile = join(LOG_DIR, `nova-${today}.log`)
            this.cleanOldLogs()
        }
    }

    private cleanOldLogs(): void {
        try {
            const files = readdirSync(LOG_DIR)
                .filter(f => f.startsWith('nova-') && f.endsWith('.log'))
                .sort()

            while (files.length > MAX_LOG_DAYS) {
                const oldest = files.shift()
                if (oldest) {
                    try { unlinkSync(join(LOG_DIR, oldest)) } catch { /* ok */ }
                }
            }
        } catch { /* non-critical */ }
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVELS[level] >= LOG_LEVELS[MIN_LEVEL]
    }

    private format(level: LogLevel, args: any[]): string {
        // Local time (sortable, with timezone offset) instead of UTC —
        // logs should match the wall clock the user sees (e.g. 15:14 Vienna, not 13:14 UTC)
        const d = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const tzMin = -d.getTimezoneOffset()
        const tzSign = tzMin >= 0 ? '+' : '-'
        const tzH = pad(Math.floor(Math.abs(tzMin) / 60))
        const tzM = pad(Math.abs(tzMin) % 60)
        const timestamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${tzSign}${tzH}:${tzM}`
        const levelTag = level.toUpperCase().padEnd(5)
        const message = args.map(a =>
            typeof a === 'string' ? a : JSON.stringify(a)
        ).join(' ')
        return `${timestamp} [${levelTag}] ${message}`
    }

    private writeToFile(line: string): void {
        try {
            this.rotateIfNeeded()
            appendFileSync(this.logFile, line + '\n')
        } catch { /* non-critical — don't crash for logging */ }
    }

    debug(...args: any[]): void {
        if (!this.shouldLog('debug')) return
        const line = this.format('debug', args)
        originalConsole.log(line)
        this.writeToFile(line)
    }

    info(...args: any[]): void {
        if (!this.shouldLog('info')) return
        const line = this.format('info', args)
        originalConsole.log(line)
        this.writeToFile(line)
    }

    warn(...args: any[]): void {
        if (!this.shouldLog('warn')) return
        const line = this.format('warn', args)
        originalConsole.warn(line)
        this.writeToFile(line)
    }

    error(...args: any[]): void {
        if (!this.shouldLog('error')) return
        const line = this.format('error', args)
        originalConsole.error(line)
        this.writeToFile(line)
    }

    /** Get path to current log file */
    getLogPath(): string {
        this.rotateIfNeeded()
        return this.logFile
    }
}

// ============================================
// Console Override (zero-migration)
// ============================================

// Keep originals for internal use
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
}

// Singleton
const logger = new NovaLogger()

/**
 * Install global console override.
 * After calling this, all console.log/warn/error calls
 * automatically get timestamps and file logging.
 */
export function installGlobalLogger(): void {
    console.log = (...args: any[]) => logger.info(...args)
    console.warn = (...args: any[]) => logger.warn(...args)
    console.error = (...args: any[]) => logger.error(...args)
}

export { logger, originalConsole }
export default logger
