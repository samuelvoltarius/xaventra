/**
 * LLM Batch Processor — Intelligent Request Batching
 * 
 * Instead of firing sequential LLM calls for every small task,
 * Nova batches compatible requests and processes them together.
 * 
 * Benefits:
 * - Fewer API calls = lower cost
 * - Less latency for multi-step tasks
 * - Better context utilization
 * 
 * How it works:
 * 1. Requests arrive → added to batch queue
 * 2. Queue timer fires OR queue is full → process batch
 * 3. Single LLM call with combined prompt
 * 4. Response split back to individual requesters
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'batch')

// ============================================
// Types
// ============================================

interface BatchItem {
    id: string
    prompt: string
    category: 'internal' | 'analysis' | 'summary' | 'translation'
    priority: 'low' | 'normal' | 'high'
    timestamp: number
    resolve: (result: string) => void
    reject: (error: Error) => void
}

interface BatchStats {
    totalBatched: number
    totalSaved: number  // How many individual calls were saved
    avgBatchSize: number
    lastBatch: string
}

// ============================================
// Config
// ============================================

const BATCH_CONFIG = {
    maxBatchSize: 5,         // Max items per batch
    maxWaitMs: 3000,         // Max wait before flushing (3 seconds)
    minBatchSize: 2,         // Don't batch if only 1 item
    maxPromptLength: 2000,   // Max chars per individual prompt in batch
    categories: ['internal', 'analysis', 'summary', 'translation'] as const,
}

// ============================================
// State
// ============================================

const queue: BatchItem[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
let stats: BatchStats = {
    totalBatched: 0,
    totalSaved: 0,
    avgBatchSize: 0,
    lastBatch: '',
}

// ============================================
// Core
// ============================================

/**
 * Add a request to the batch queue.
 * Returns a promise that resolves when the batch is processed.
 */
export function batchRequest(
    prompt: string,
    category: BatchItem['category'] = 'internal',
    priority: BatchItem['priority'] = 'normal'
): Promise<string> {
    // High priority = don't batch, execute immediately
    if (priority === 'high') {
        return executeImmediate(prompt)
    }

    // Prompt too long for batching
    if (prompt.length > BATCH_CONFIG.maxPromptLength) {
        return executeImmediate(prompt)
    }

    return new Promise((resolve, reject) => {
        const item: BatchItem = {
            id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            prompt,
            category,
            priority,
            timestamp: Date.now(),
            resolve,
            reject,
        }

        queue.push(item)

        // If queue is full, flush immediately
        if (queue.length >= BATCH_CONFIG.maxBatchSize) {
            flushBatch()
            return
        }

        // Start timer if not already running
        if (!batchTimer) {
            batchTimer = setTimeout(() => {
                flushBatch()
            }, BATCH_CONFIG.maxWaitMs)
        }
    })
}

/**
 * Force flush the current batch queue
 */
export async function flushBatch(): Promise<void> {
    if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
    }

    if (queue.length === 0) return

    // Take all items from queue
    const items = queue.splice(0, BATCH_CONFIG.maxBatchSize)

    // If only 1 item, execute directly (no batching overhead)
    if (items.length < BATCH_CONFIG.minBatchSize) {
        for (const item of items) {
            executeImmediate(item.prompt)
                .then(item.resolve)
                .catch(item.reject)
        }
        return
    }

    // Group by category for better results
    const groups = new Map<string, BatchItem[]>()
    for (const item of items) {
        const group = groups.get(item.category) || []
        group.push(item)
        groups.set(item.category, group)
    }

    // Process each group as a combined prompt
    for (const [category, groupItems] of groups) {
        await processBatchGroup(category, groupItems)
    }
}

/**
 * Process a group of batched items with a single LLM call
 */
async function processBatchGroup(category: string, items: BatchItem[]): Promise<void> {
    const batchPrompt = buildBatchPrompt(category, items)

    try {
        // Use internal LLM for batch processing
        let llmFactory: any = null
        try {
            llmFactory = await import('./llm-factory.js')
        } catch {
            // Fallback: process individually
            for (const item of items) {
                executeImmediate(item.prompt).then(item.resolve).catch(item.reject)
            }
            return
        }

        const llm = await llmFactory.createLLM?.({ provider: 'auto' }).catch(() => null)
        if (!llm) {
            for (const item of items) {
                executeImmediate(item.prompt).then(item.resolve).catch(item.reject)
            }
            return
        }

        const response = await llm.generate({
            prompt: batchPrompt,
            maxTokens: 2000,
            temperature: 0.3,
        })

        const responseText = response?.text || response?.content || ''

        // Parse batched response back to individual results
        const results = parseBatchResponse(responseText, items.length)

        for (let i = 0; i < items.length; i++) {
            items[i].resolve(results[i] || responseText)
        }

        // Update stats
        stats.totalBatched += items.length
        stats.totalSaved += items.length - 1  // Saved N-1 calls
        stats.avgBatchSize = stats.totalBatched > 0
            ? (stats.avgBatchSize * (stats.totalBatched - items.length) + items.length) / stats.totalBatched
            : items.length
        stats.lastBatch = new Date().toISOString()

        console.log(`[Batch] ✅ ${items.length} Requests als 1 verarbeitet (${stats.totalSaved} Calls gespart)`)
        saveStats()
    } catch (err: any) {
        console.log(`[Batch] ⚠️ Batch failed: ${err.message?.slice(0, 80)}`)
        // On failure, reject all items
        for (const item of items) {
            item.reject(new Error(`Batch processing failed: ${err.message}`))
        }
    }
}

/**
 * Build a combined prompt for multiple requests
 */
function buildBatchPrompt(category: string, items: BatchItem[]): string {
    const lines = [
        `Du bekommst ${items.length} separate Aufgaben. Beantworte JEDE einzeln.`,
        `Trenne deine Antworten mit "---BATCH_SEPARATOR---"`,
        '',
    ]

    for (let i = 0; i < items.length; i++) {
        lines.push(`### Aufgabe ${i + 1}:`)
        lines.push(items[i].prompt)
        lines.push('')
    }

    return lines.join('\n')
}

/**
 * Parse a batched LLM response back into individual results
 */
function parseBatchResponse(response: string, expectedCount: number): string[] {
    // Try separator-based split first
    const parts = response.split('---BATCH_SEPARATOR---')
        .map(p => p.trim())
        .filter(p => p.length > 0)

    if (parts.length >= expectedCount) {
        return parts.slice(0, expectedCount)
    }

    // Fallback: try numbered section split
    const numbered = response.split(/###\s*(?:Aufgabe|Antwort|Task)\s*\d+/i)
        .map(p => p.trim())
        .filter(p => p.length > 0)

    if (numbered.length >= expectedCount) {
        return numbered.slice(0, expectedCount)
    }

    // Last resort: return full response for each
    return Array(expectedCount).fill(response)
}

/**
 * Execute a single prompt immediately (no batching)
 */
async function executeImmediate(prompt: string): Promise<string> {
    try {
        const llmFactory = await import('./llm-factory.js')
        const llm = await llmFactory.createLLM?.({ provider: 'auto' }).catch(() => null)
        if (!llm) return 'LLM nicht verfügbar'

        const response = await llm.generate({
            prompt,
            maxTokens: 1000,
            temperature: 0.3,
        })

        return response?.text || response?.content || ''
    } catch (err: any) {
        return `Fehler: ${err.message?.slice(0, 80)}`
    }
}

// ============================================
// Status
// ============================================

/**
 * Get batch processing stats
 */
export function getBatchStats(): BatchStats {
    return { ...stats }
}

/**
 * Get human-readable status
 */
export function getBatchStatus(): string {
    if (stats.totalBatched === 0) return '📦 Batch: Noch keine Batches verarbeitet'
    return `📦 Batch: ${stats.totalBatched} batched, ${stats.totalSaved} Calls gespart, Ø ${stats.avgBatchSize.toFixed(1)} pro Batch`
}

/**
 * Get current queue size
 */
export function getQueueSize(): number {
    return queue.length
}

// ============================================
// Persistence
// ============================================

function saveStats(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'stats.json'), JSON.stringify(stats, null, 2))
    } catch { /* non-critical */ }
}

// ============================================
// Init
// ============================================

export function initBatchProcessor(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    try {
        const statsPath = join(DATA_DIR, 'stats.json')
        if (existsSync(statsPath)) {
            const { readFileSync } = require('node:fs')
            stats = JSON.parse(readFileSync(statsPath, 'utf-8'))
        }
    } catch { /* start fresh */ }

    console.log(`[Batch] ✅ Initialized — ${stats.totalSaved} Calls bisher gespart`)
}
