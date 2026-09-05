/**
 * Nova - Structured Logger
 * 
 * JSON-structured logging for debugging and monitoring.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
    timestamp: string
    level: LogLevel
    message: string
    context?: Record<string, unknown>
    layer?: string
    error?: Error | { message: string; stack?: string }
    metadata?: Record<string, unknown>
}

interface LayerLogger {
    debug: (message: string, context?: Record<string, unknown>) => void
    info: (message: string, context?: Record<string, unknown>) => void
    warn: (message: string, context?: Record<string, unknown>) => void
    error: (message: string, context?: Record<string, unknown>) => void
}

const logs: LogEntry[] = []
const MAX_LOGS = 1000

function createEntry(level: LogLevel, message: string, context?: Record<string, unknown>, layer?: string): LogEntry {
    return {
        timestamp: new Date().toISOString(),
        level,
        message,
        context,
        layer,
    }
}

export function debug(message: string, context?: Record<string, unknown>): void {
    const entry = createEntry('debug', message, context)
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    if (process.env.NOVA_DEBUG === 'true') {
        console.log(`[DEBUG] ${message}`, context || '')
    }
}

export function info(message: string, context?: Record<string, unknown>): void {
    const entry = createEntry('info', message, context)
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    console.log(`[INFO] ${message}`)
}

export function warn(message: string, context?: Record<string, unknown>): void {
    const entry = createEntry('warn', message, context)
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    console.warn(`[WARN] ${message}`)
}

export function error(message: string, context?: Record<string, unknown>): void {
    const entry = createEntry('error', message, context)
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    console.error(`[ERROR] ${message}`, context || '')
}

export function fatal(message: string, context?: Record<string, unknown>): void {
    const entry = createEntry('fatal', message, context)
    logs.push(entry)
    if (logs.length > MAX_LOGS) logs.shift()
    console.error(`[FATAL] ${message}`, context || '')
}

export function log(entry: Partial<LogEntry> & { message: string }): void {
    const fullEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: entry.level || 'info',
        message: entry.message,
        context: entry.context,
        layer: entry.layer,
        error: entry.error,
        metadata: entry.metadata,
    }
    logs.push(fullEntry)
    if (logs.length > MAX_LOGS) logs.shift()
}

export function getLogs(level?: LogLevel, limit = 100): LogEntry[] {
    let filtered = level ? logs.filter(l => l.level === level) : logs
    return filtered.slice(-limit)
}

export function clearLogs(): void {
    logs.length = 0
}

// Create a logger instance
export function getLogger(): typeof logger {
    return logger
}

// Create a layer-specific logger
export function createLayerLogger(layerName: string): LayerLogger {
    return {
        debug: (message, context) => {
            const entry = createEntry('debug', `[${layerName}] ${message}`, context, layerName)
            logs.push(entry)
            if (logs.length > MAX_LOGS) logs.shift()
            if (process.env.NOVA_DEBUG === 'true') {
                console.log(`[${layerName}] ${message}`)
            }
        },
        info: (message, context) => {
            const entry = createEntry('info', `[${layerName}] ${message}`, context, layerName)
            logs.push(entry)
            if (logs.length > MAX_LOGS) logs.shift()
            console.log(`[${layerName}] ${message}`)
        },
        warn: (message, context) => {
            const entry = createEntry('warn', `[${layerName}] ${message}`, context, layerName)
            logs.push(entry)
            if (logs.length > MAX_LOGS) logs.shift()
            console.warn(`[${layerName}] ${message}`)
        },
        error: (message, context) => {
            const entry = createEntry('error', `[${layerName}] ${message}`, context, layerName)
            logs.push(entry)
            if (logs.length > MAX_LOGS) logs.shift()
            console.error(`[${layerName}] ${message}`)
        },
    }
}

export const logger = { debug, info, warn, error, fatal, log, getLogs, clearLogs }
export default logger
