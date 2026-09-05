/**
 * Persistent Incoming Message Queue
 *
 * Every message is logged to disk BEFORE processing.
 * On startup, unprocessed messages are drained automatically.
 *
 * This solves two problems:
 * 1. Messages sent while Nova was offline are replayed on next boot
 *    (Telegram already buffers them via getUpdates, but this ensures
 *    no loss if Nova crashes mid-processing)
 * 2. If Nova crashes after receiving but before replying, the message
 *    is retried on next startup (idempotent — same message gets same answer)
 *
 * Storage: .nova-data/msg-queue.jsonl (append-only, compacted on startup)
 * Max retention: 24 hours (Telegram's own buffer window)
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../core/atomic-storage.js'
import { createHash } from 'node:crypto'
import { isHaStateAvailable, readHaRecords, writeHaRecord } from '../core/ha-state.js'

// ============================================
// Types
// ============================================

export type MsgStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface QueuedMessage {
    id: string           // Unique per message (e.g. Telegram update_id)
    chatId: string       // Channel-specific chat identifier
    from: string         // Sender identifier
    content: string      // Message text (trimmed to 4000 chars max)
    channel: string      // 'Telegram' | 'Discord' | etc.
    receivedAt: string   // ISO timestamp
    processedAt?: string
    updatedAt?: string
    status: MsgStatus
    retries: number
}

// ============================================
// Storage
// ============================================

const QUEUE_DIR = join(process.cwd(), '.nova-data')
const QUEUE_FILE = join(QUEUE_DIR, 'msg-queue.jsonl')
const MAX_AGE_MS = 24 * 60 * 60 * 1000  // 24 hours
const MAX_RETRIES = 3
const SHARED_QUEUE_SCOPE = 'ha-message-queue'

// In-memory index: id → status (for fast lookups without re-reading file)
const _index = new Map<string, MsgStatus>()
let _initialized = false

function ensureDir(): void {
    if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true })
}

// ============================================
// Init — load existing queue on startup
// ============================================

function loadQueue(): QueuedMessage[] {
    ensureDir()
    if (!existsSync(QUEUE_FILE)) return []
    try {
        return readFileSync(QUEUE_FILE, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as QueuedMessage)
    } catch {
        return []
    }
}

function compactQueue(messages: QueuedMessage[]): void {
    ensureDir()
    const lines = messages.map(m => JSON.stringify(m)).join('\n')
    atomicWriteFileSync(QUEUE_FILE, lines ? lines + '\n' : '')
}

/**
 * Initialize the queue: load existing entries into memory index,
 * drop entries older than 24h, compact the file.
 * Returns messages that were 'pending' or 'processing' (need replay).
 */
export function initMessageQueue(): QueuedMessage[] {
    if (_initialized) return []
    _initialized = true

    const now = Date.now()
    const messages = loadQueue()
    const fresh = messages.filter(m => {
        const age = now - new Date(m.receivedAt).getTime()
        return age < MAX_AGE_MS
    })

    // Rebuild in-memory index
    _index.clear()
    for (const m of fresh) {
        _index.set(m.id, m.status)
    }

    // Compact file (drop old entries)
    if (fresh.length !== messages.length) {
        compactQueue(fresh)
        console.log(`[MsgQueue] Compacted: kept ${fresh.length}/${messages.length} entries`)
    }

    // Return messages that need replay (pending / processing with retries left)
    const needsReplay = fresh.filter(m =>
        (m.status === 'pending' || m.status === 'processing') &&
        m.retries < MAX_RETRIES
    )

    if (needsReplay.length > 0) {
        console.log(`[MsgQueue] 📬 ${needsReplay.length} unprocessed message(s) from last session — replaying`)
    } else {
        console.log(`[MsgQueue] ✓ Queue clean (${fresh.length} entries, none pending)`)
    }

    return needsReplay
}

function sharedRecordId(message: Pick<QueuedMessage, 'channel' | 'id'>): string {
    const digest = createHash('sha256').update(`${message.channel}:${message.id}`).digest('hex').slice(0, 32)
    return `ha_message_${digest}`
}

function mirrorMessage(message: QueuedMessage): void {
    void writeHaRecord(SHARED_QUEUE_SCOPE, sharedRecordId(message), message, {
        channel: message.channel,
        messageId: message.id,
        status: message.status,
    }).catch(() => { /* local queue remains available */ })
}

/**
 * Merge the encrypted durable queue before an exclusive channel starts.
 * A record left in `processing` belonged to the previous lease holder and is
 * deliberately returned to `pending` for the promoted node.
 */
export async function hydrateSharedMessageQueue(): Promise<{ available: boolean; pending: QueuedMessage[] }> {
    if (!(await isHaStateAvailable())) return { available: false, pending: [] }

    const local = loadQueue()
    const merged = new Map(local.map(message => [message.id, message]))
    const records = await readHaRecords<QueuedMessage>(SHARED_QUEUE_SCOPE, 500)
    const now = Date.now()
    for (const record of records) {
        const remote = record.payload
        if (!remote?.id || !remote.channel || !remote.receivedAt) continue
        if (now - Date.parse(remote.receivedAt) >= MAX_AGE_MS) continue
        const current = merged.get(remote.id)
        const currentTimestamp = current ? Date.parse(current.updatedAt || current.processedAt || current.receivedAt) : 0
        const remoteTimestamp = Date.parse(remote.updatedAt || remote.processedAt || remote.receivedAt)
        if (!current || remoteTimestamp >= currentTimestamp) {
            merged.set(remote.id, {
                ...remote,
                status: remote.status === 'processing' ? 'pending' : remote.status,
                updatedAt: new Date(Math.max(record.timestamp, remoteTimestamp || 0)).toISOString(),
            })
        }
    }

    const fresh = [...merged.values()].filter(message => now - Date.parse(message.receivedAt) < MAX_AGE_MS)
    compactQueue(fresh)
    _index.clear()
    for (const message of fresh) _index.set(message.id, message.status)
    const pending = fresh.filter(message => message.status === 'pending' && message.retries < MAX_RETRIES)
    return { available: true, pending }
}

// ============================================
// Public API
// ============================================

/**
 * Log an incoming message BEFORE processing it.
 * Returns the message id for later status updates.
 */
export function logIncoming(params: {
    id: string
    chatId: string
    from: string
    content: string
    channel: string
}): boolean {
    // Skip if already known (duplicate delivery)
    if (_index.has(params.id)) return false

    const msg: QueuedMessage = {
        id: params.id,
        chatId: params.chatId,
        from: params.from,
        content: params.content.slice(0, 4000),
        channel: params.channel,
        receivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'pending',
        retries: 0,
    }

    _index.set(msg.id, 'pending')
    ensureDir()
    appendFileSync(QUEUE_FILE, JSON.stringify(msg) + '\n')
    mirrorMessage(msg)
    return true
}

/**
 * Mark message as being actively processed (before LLM call).
 * Prevents duplicate processing if multiple processes are running.
 */
export function markProcessing(id: string): void {
    _updateStatus(id, 'processing')
}

/**
 * Mark message as successfully processed (after reply was sent).
 */
export function markDone(id: string): void {
    _updateStatus(id, 'done')
}

/**
 * Mark message as failed (max retries exceeded or hard error).
 */
export function markFailed(id: string): void {
    _updateStatus(id, 'failed')
}

/**
 * Increment retry counter for a message.
 */
export function incrementRetry(id: string): void {
    const messages = loadQueue()
    const msg = messages.find(m => m.id === id)
    if (msg) {
        msg.retries++
        msg.updatedAt = new Date().toISOString()
        if (msg.retries >= MAX_RETRIES) {
            msg.status = 'failed'
            _index.set(id, 'failed')
            console.log(`[MsgQueue] ⛔ Message ${id} failed after ${MAX_RETRIES} retries`)
        }
        compactQueue(messages)
        mirrorMessage(msg)
    }
}

function _updateStatus(id: string, status: MsgStatus): void {
    _index.set(id, status)
    // Update in file (rewrite only the changed line)
    const messages = loadQueue()
    const msg = messages.find(m => m.id === id)
    if (msg) {
        msg.status = status
        msg.updatedAt = new Date().toISOString()
        if (status === 'done' || status === 'failed') {
            msg.processedAt = new Date().toISOString()
        }
        compactQueue(messages)
        mirrorMessage(msg)
    }
}

export function isMessageProcessable(id: string): boolean {
    const status = _index.get(id)
    return status === 'pending' || status === 'processing'
}

/**
 * Get queue stats (for /status and /doctor commands).
 */
export function getQueueStats(): { total: number; pending: number; done: number; failed: number } {
    let pending = 0, done = 0, failed = 0
    for (const status of _index.values()) {
        if (status === 'pending' || status === 'processing') pending++
        else if (status === 'done') done++
        else if (status === 'failed') failed++
    }
    return { total: _index.size, pending, done, failed }
}

export default { initMessageQueue, hydrateSharedMessageQueue, logIncoming, markProcessing, markDone, markFailed, incrementRetry, isMessageProcessable, getQueueStats }
