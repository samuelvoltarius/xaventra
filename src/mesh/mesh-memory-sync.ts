/**
 * Mesh Memory Sync — Global Brain
 * 
 * All nodes share a unified memory pool:
 * - Memories created on any node are synced to all others
 * - Deduplication via content hash
 * - Conflict resolution: newest wins
 * - Sync via WebSocket Event Hub (real-time)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const MEMORY_DIR = join(process.cwd(), '.nova-data', 'mesh-memory')
const SYNC_LOG = join(MEMORY_DIR, 'sync-log.json')

// ============================================
// Types
// ============================================

interface SharedMemory {
    id: string
    content: string
    type: 'fact' | 'preference' | 'correction' | 'insight' | 'project'
    source: string       // Which node created it
    timestamp: string
    hash: string          // Content hash for dedup
    synced: boolean
    /** Visibility; only 'global' entries enter the shared mesh pool (UEB-17). Missing = legacy global. */
    scope?: string
}

interface SyncState {
    lastSync: string
    totalSynced: number
    nodeMemories: Record<string, number>  // node -> count
    /** Content hashes that were forgotten; never re-accepted from the mesh (UEB-17). */
    tombstones?: string[]
}

const MAX_TOMBSTONES = 5_000
export const GLOBAL_MEMORY_SCOPE = 'global'

function memoryHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function isTombstoned(hash: string): boolean {
    return (syncState.tombstones || []).includes(hash)
}

// ============================================
// State
// ============================================

let sharedMemories: SharedMemory[] = []
let syncState: SyncState = {
    lastSync: new Date().toISOString(),
    totalSynced: 0,
    nodeMemories: {},
}

// ============================================
// Core
// ============================================

/**
 * Add a memory to the shared pool and broadcast to mesh
 */
export async function shareMemory(content: string, type: SharedMemory['type'], source: string, scope: string = GLOBAL_MEMORY_SCOPE): Promise<void> {
    // UEB-17: private/scoped memories never enter the shared pool or the mesh.
    if (scope !== GLOBAL_MEMORY_SCOPE) return
    const hash = memoryHash(content)

    // Dedup check; a forgotten memory is not shared again implicitly
    if (sharedMemories.some(m => m.hash === hash) || isTombstoned(hash)) return

    const memory: SharedMemory = {
        id: `mem_${Date.now()}_${hash.slice(0, 8)}`,
        content,
        type,
        source,
        timestamp: new Date().toISOString(),
        hash,
        synced: false,
        scope,
    }

    sharedMemories.push(memory)
    if (sharedMemories.length > 500) sharedMemories = sharedMemories.slice(-500)

    // Broadcast via Event Hub
    try {
        const { emit } = await import('./event-hub.js')
        emit('mesh:memory_share', {
            memory,
            from: source,
        })
        memory.synced = true
        console.log(`[MeshMemory] 📡 Shared: "${content.slice(0, 50)}..." → mesh`)
    } catch { /* Event Hub not available */ }

    saveMemories()
}

/**
 * Receive a shared memory from another node
 */
export function receiveSharedMemory(memory: SharedMemory): boolean {
    if (!memory || typeof memory.content !== 'string' || typeof memory.hash !== 'string') return false
    // UEB-17: only global entries are accepted, forgotten ones stay forgotten
    if ((memory.scope ?? GLOBAL_MEMORY_SCOPE) !== GLOBAL_MEMORY_SCOPE || isTombstoned(memory.hash)) return false
    // Dedup
    if (sharedMemories.some(m => m.hash === memory.hash)) return false

    memory.synced = true
    sharedMemories.push(memory)
    syncState.totalSynced++
    syncState.nodeMemories[memory.source] = (syncState.nodeMemories[memory.source] || 0) + 1
    syncState.lastSync = new Date().toISOString()

    saveMemories()
    console.log(`[MeshMemory] 📥 Received from ${memory.source}: "${memory.content.slice(0, 50)}..."`)
    return true
}

/**
 * UEB-17: "vergiss" must also remove mesh copies. Removes matching entries
 * from the shared pool (and shared.json), records tombstones so the content
 * is not re-imported, and broadcasts the forget to the other nodes.
 */
export async function forgetSharedMemory(match: { content?: string; hash?: string }, options: { broadcast?: boolean } = {}): Promise<number> {
    const hashes = new Set<string>()
    if (typeof match.hash === 'string' && match.hash) hashes.add(match.hash)
    if (typeof match.content === 'string' && match.content) hashes.add(memoryHash(match.content))
    if (!hashes.size) return 0
    const before = sharedMemories.length
    sharedMemories = sharedMemories.filter(m => !hashes.has(m.hash))
    const removed = before - sharedMemories.length
    syncState.tombstones = [...new Set([...(syncState.tombstones || []), ...hashes])].slice(-MAX_TOMBSTONES)
    saveMemories()
    if (options.broadcast !== false) {
        try {
            const { emit } = await import('./event-hub.js')
            emit('mesh:memory_forget', { hashes: [...hashes] })
        } catch { /* Event Hub not available */ }
    }
    return removed
}

/**
 * Search shared memories
 */
export function searchSharedMemories(query: string, limit = 5): SharedMemory[] {
    const q = query.toLowerCase()
    return sharedMemories
        .filter(m => m.content.toLowerCase().includes(q))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit)
}

/**
 * Get sync status
 */
export function getMeshMemoryStatus(): string {
    const total = sharedMemories.length
    const synced = sharedMemories.filter(m => m.synced).length
    const nodes = Object.entries(syncState.nodeMemories)
        .map(([n, c]) => `${n}: ${c}`)
        .join(', ')
    return `📦 ${total} shared memories (${synced} synced) | Nodes: ${nodes || 'keine'}`
}

// ============================================
// Persistence
// ============================================

function saveMemories(): void {
    try {
        if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
        writeFileSync(join(MEMORY_DIR, 'shared.json'), JSON.stringify(sharedMemories.slice(-200), null, 2))
        writeFileSync(SYNC_LOG, JSON.stringify(syncState, null, 2))
    } catch { /* non-critical */ }
}

function loadMemories(): void {
    try {
        const path = join(MEMORY_DIR, 'shared.json')
        if (existsSync(path)) {
            sharedMemories = JSON.parse(readFileSync(path, 'utf-8'))
        }
        if (existsSync(SYNC_LOG)) {
            syncState = JSON.parse(readFileSync(SYNC_LOG, 'utf-8'))
        }
    } catch { /* start fresh */ }
}

// ============================================
// Init
// ============================================

export async function initMeshMemory(): Promise<void> {
    if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true })
    loadMemories()

    // Subscribe to memory share events from other nodes
    try {
        const { on } = await import('./event-hub.js')
        on('mesh:memory_share', (event: any) => {
            if (event.data?.memory) {
                receiveSharedMemory(event.data.memory)
            }
        })
        on('mesh:memory_forget', (event: any) => {
            const hashes = Array.isArray(event.data?.hashes) ? event.data.hashes.filter((hash: unknown) => typeof hash === 'string' && /^[0-9a-f]{16}$/.test(hash)) : []
            for (const hash of hashes.slice(0, 500)) void forgetSharedMemory({ hash }, { broadcast: false })
        })
    } catch { /* Event Hub not available */ }

    console.log(`[MeshMemory] ✅ Initialized — ${sharedMemories.length} shared memories`)
}
