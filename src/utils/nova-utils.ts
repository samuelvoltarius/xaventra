/**
 * Nova Utils
 * 
 * Inspired by OpenClaw's utils/ (22 files)
 * General-purpose utilities for the Nova ecosystem.
 */

// ============================================
// Timeout & Fetch Helpers
// ============================================

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        promise.then(
            v => { clearTimeout(timer); resolve(v) },
            e => { clearTimeout(timer); reject(e) },
        )
    })
}

export async function fetchWithTimeout(
    url: string,
    options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
    const { timeoutMs = 30_000, ...fetchOpts } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...fetchOpts, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

// ============================================
// JSON & Parsing
// ============================================

export function safeParseJson<T = unknown>(raw: string): T | null {
    try { return JSON.parse(raw) as T }
    catch { return null }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === '[object Object]'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ============================================
// Number & Clamping
// ============================================

export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

export function clampInt(value: number, min: number, max: number): number {
    return Math.round(clamp(value, min, max))
}

// ============================================
// String Utils
// ============================================

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function truncate(str: string, maxLen: number, suffix = '...'): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - suffix.length) + suffix
}

export function slugify(str: string): string {
    return str
        .toLowerCase()
        .replace(/[äöüß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c] || c))
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

// ============================================
// Shell Argument Splitting
// ============================================

export function shellArgv(input: string): string[] {
    const args: string[] = []
    let current = ''
    let inSingle = false
    let inDouble = false
    let escaped = false

    for (const char of input) {
        if (escaped) { current += char; escaped = false; continue }
        if (char === '\\' && !inSingle) { escaped = true; continue }
        if (char === "'" && !inDouble) { inSingle = !inSingle; continue }
        if (char === '"' && !inSingle) { inDouble = !inDouble; continue }
        if (char === ' ' && !inSingle && !inDouble) {
            if (current) { args.push(current); current = '' }
            continue
        }
        current += char
    }
    if (current) args.push(current)
    return args
}

// ============================================
// Queue & Batch Helpers
// ============================================

export class PriorityQueue<T> {
    private items: Array<{ value: T; priority: number }> = []

    enqueue(value: T, priority: number): void {
        const entry = { value, priority }
        const idx = this.items.findIndex(i => i.priority > priority)
        if (idx === -1) this.items.push(entry)
        else this.items.splice(idx, 0, entry)
    }

    dequeue(): T | undefined {
        return this.items.shift()?.value
    }

    peek(): T | undefined {
        return this.items[0]?.value
    }

    get size(): number {
        return this.items.length
    }

    isEmpty(): boolean {
        return this.items.length === 0
    }
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
    let timer: ReturnType<typeof setTimeout> | null = null
    return ((...args: unknown[]) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => fn(...args), ms)
    }) as T
}

export function throttle<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
    let last = 0
    return ((...args: unknown[]) => {
        const now = Date.now()
        if (now - last >= ms) { last = now; fn(...args) }
    }) as T
}

export async function batchProcess<T, R>(
    items: T[],
    processFn: (item: T) => Promise<R>,
    concurrency = 5,
): Promise<R[]> {
    const results: R[] = []
    const queue = [...items]

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift()!
            results.push(await processFn(item))
        }
    })

    await Promise.all(workers)
    return results
}

// ============================================
// Usage & Token Formatting
// ============================================

export function formatTokens(count: number): string {
    if (count < 1000) return count.toString()
    if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
    return `${(count / 1_000_000).toFixed(2)}M`
}

export function formatCost(cents: number): string {
    if (cents < 1) return `$${(cents / 100).toFixed(4)}`
    if (cents < 100) return `$${(cents / 100).toFixed(2)}`
    return `$${(cents / 100).toFixed(2)}`
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const mins = Math.floor(ms / 60_000)
    const secs = Math.floor((ms % 60_000) / 1000)
    return `${mins}m ${secs}s`
}

// ============================================
// Delivery Context
// ============================================

export interface DeliveryRecord {
    messageId: string
    channel: string
    timestamp: number
    status: 'pending' | 'sent' | 'delivered' | 'failed'
    retries: number
    error?: string
}

const deliveryLog: DeliveryRecord[] = []

export function trackDelivery(record: DeliveryRecord): void {
    deliveryLog.push(record)
    // Keep last 1000
    if (deliveryLog.length > 1000) deliveryLog.splice(0, deliveryLog.length - 1000)
}

export function getDeliveryLog(limit = 50): DeliveryRecord[] {
    return deliveryLog.slice(-limit)
}

export function getDeliveryStats(): { total: number; sent: number; failed: number; pending: number } {
    return {
        total: deliveryLog.length,
        sent: deliveryLog.filter(d => d.status === 'sent' || d.status === 'delivered').length,
        failed: deliveryLog.filter(d => d.status === 'failed').length,
        pending: deliveryLog.filter(d => d.status === 'pending').length,
    }
}

// ============================================
// Sleep & Retry
// ============================================

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export async function retry<T>(
    fn: () => Promise<T>,
    options: { maxAttempts?: number; delayMs?: number; backoff?: number } = {},
): Promise<T> {
    const { maxAttempts = 3, delayMs = 1000, backoff = 2 } = options
    let lastError: Error | undefined
    let delay = delayMs

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn()
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err))
            if (attempt < maxAttempts) {
                await sleep(delay)
                delay *= backoff
            }
        }
    }
    throw lastError
}

// ============================================
// Path & Home Dir
// ============================================

export function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

export function shortenHomePath(input: string): string {
    const home = require('node:os').homedir() as string
    if (input.startsWith(home)) return '~' + input.slice(home.length).replace(/\\/g, '/')
    return input
}

export function expandTilde(input: string): string {
    if (!input.startsWith('~')) return input
    const home = require('node:os').homedir() as string
    return home + input.slice(1)
}
