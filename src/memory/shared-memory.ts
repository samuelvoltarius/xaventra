/**
 * Shared memory sync via Supabase.
 *
 * Local memory remains the source of immediate truth. This module mirrors
 * entries to Supabase and can pull entries written by other Nova instances.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'
import { assertFenced, getHeldFence } from '../mesh/fence.js'


export type SharedMemoryEntry = {
    id: string
    userId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: number
    keywords?: string[]
    sourceNode?: string
    scope?: string
    metadata?: Record<string, unknown>
    /** CL-07: lease epoch of the fenced writer (v5 column; absent before). */
    writerEpoch?: number
}

const TABLE = 'nova_shared_memory'
let warnedSplitAuthority = false

function loadLeaseAuthorityUrl(): string {
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.supabase?.meshUrl) return String(config.supabase.meshUrl)
        }
    } catch { /* ignore */ }
    return process.env.NOVA_MESH_SUPABASE_URL || ''
}

function loadSupabaseConfig(): { url: string; key: string } {
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.supabase?.learningUrl && config.supabase?.learningKey) {
                return { url: config.supabase.learningUrl, key: config.supabase.learningKey }
            }
            if (config.supabase?.meshUrl && config.supabase?.meshKey) {
                return { url: config.supabase.meshUrl, key: config.supabase.meshKey }
            }
        }
    } catch { /* ignore */ }

    if (process.env.NOVA_LEARNING_SUPABASE_URL && process.env.NOVA_LEARNING_SUPABASE_KEY) {
        return {
            url: process.env.NOVA_LEARNING_SUPABASE_URL,
            key: process.env.NOVA_LEARNING_SUPABASE_KEY,
        }
    }

    // Worker nodes normally receive only the mesh credentials. Federated
    // memory must use the same durable Supabase authority or it silently
    // becomes local-only exactly when a failover happens.
    if (process.env.NOVA_MESH_SUPABASE_URL && process.env.NOVA_MESH_SUPABASE_KEY) {
        return {
            url: process.env.NOVA_MESH_SUPABASE_URL,
            key: process.env.NOVA_MESH_SUPABASE_KEY,
        }
    }

    return { url: '', key: '' }
}

export function readNodeId(): string {
    const configured = String(process.env.NOVA_NODE_ID || '').trim()
    if (configured) return configured
    try {
        return readFileSync(join(process.cwd(), '.nova-data', 'instance-id.txt'), 'utf-8').trim()
    } catch {
        return 'unknown'
    }
}

function headers(key: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
    }
}

export async function pushSharedMemory(entry: SharedMemoryEntry): Promise<boolean> {
    const config = loadSupabaseConfig()
    if (!config.url || !config.key) return false

    const payload = {
        id: entry.id,
        user_id: entry.userId,
        role: entry.role,
        content: entry.content,
        timestamp: entry.timestamp,
        keywords: entry.keywords ?? [],
        source_node: entry.sourceNode ?? readNodeId(),
        scope: entry.scope ?? 'local-memory',
        metadata: entry.metadata ?? {},
        updated_at: new Date().toISOString(),
    }

    try {
        const existing = await fetch(`${config.url}/${TABLE}?id=eq.${encodeURIComponent(entry.id)}&select=id`, {
            method: 'GET',
            headers: headers(config.key),
            signal: AbortSignal.timeout(5000),
        })
        if (!existing.ok) return false
        const rows = (await existing.json()) as unknown[]
        const method = rows.length > 0 ? 'PATCH' : 'POST'
        const path = rows.length > 0 ? `${TABLE}?id=eq.${encodeURIComponent(entry.id)}` : TABLE

        const res = await fetch(`${config.url}/${path}`, {
            method,
            headers: {
                ...headers(config.key),
                Prefer: method === 'POST' ? 'return=minimal' : 'return=minimal',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        })
        return res.ok
    } catch {
        return false
    }
}

export async function pullSharedMemory(params: {
    userId?: string
    scope?: string
    since?: number
    limit?: number
} = {}): Promise<SharedMemoryEntry[]> {
    const config = loadSupabaseConfig()
    if (!config.url || !config.key) return []

    const filters: string[] = ['select=*', `order=timestamp.desc`, `limit=${params.limit ?? 500}`]
    if (params.userId) filters.push(`user_id=eq.${encodeURIComponent(params.userId)}`)
    if (params.scope) filters.push(`scope=eq.${encodeURIComponent(params.scope)}`)
    if (params.since) filters.push(`timestamp=gt.${params.since}`)

    try {
        const res = await fetch(`${config.url}/${TABLE}?${filters.join('&')}`, {
            method: 'GET',
            headers: headers(config.key),
            signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return []
        const rows = (await res.json()) as Array<Record<string, any>>
        return rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            role: row.role,
            content: row.content,
            timestamp: Number(row.timestamp),
            keywords: Array.isArray(row.keywords) ? row.keywords : [],
            sourceNode: row.source_node,
            scope: row.scope,
            metadata: row.metadata ?? {},
            writerEpoch: row.writer_epoch === null || row.writer_epoch === undefined ? undefined : Number(row.writer_epoch),
        }))
    } catch {
        return []
    }
}

/**
 * CL-07 fenced write for HA scopes. With a Supabase fence held and the v5
 * migration applied, the row is written through nova_fenced_upsert_shared_memory:
 * Postgres checks holder, instance, epoch and expiry against the lease row in
 * the same transaction and never lets an older writer_epoch overwrite a newer
 * one. Without a fence: enforce refuses, observe logs and writes as before.
 */
export async function pushSharedMemoryFenced(entry: SharedMemoryEntry, fenceService = 'nova-main'): Promise<boolean> {
    const fence = getHeldFence(fenceService)
    if (!fence) {
        try {
            await assertFenced(fenceService, { effect: `shared-write:${entry.scope || 'local-memory'}` })
        } catch { return false }
        return pushSharedMemory(entry)
    }
    const config = loadSupabaseConfig()
    if (!config.url || !config.key) return false
    if (fence.coordinator !== 'supabase') return pushSharedMemory(entry)
    // The fenced RPC must run in the database that holds the lease rows.
    const leaseUrl = loadLeaseAuthorityUrl()
    if (leaseUrl && leaseUrl.replace(/\/$/, '') !== config.url.replace(/\/$/, '')) {
        if (!warnedSplitAuthority) {
            warnedSplitAuthority = true
            console.warn('[SharedMemory] HA scopes live outside the lease database (learningUrl != meshUrl); fenced upsert unavailable, writing unfenced')
        }
        return pushSharedMemory(entry)
    }
    const row = {
        id: entry.id, user_id: entry.userId, role: entry.role, content: entry.content, timestamp: entry.timestamp,
        keywords: entry.keywords ?? [], source_node: entry.sourceNode ?? readNodeId(),
        scope: entry.scope ?? 'local-memory', metadata: entry.metadata ?? {},
    }
    try {
        const res = await fetch(`${config.url}/rpc/nova_fenced_upsert_shared_memory`, {
            method: 'POST', headers: headers(config.key),
            body: JSON.stringify({
                p_fence_service: fenceService, p_epoch: fence.epoch, p_holder_node_id: fence.nodeId,
                p_holder_instance_id: fence.instanceId, p_row: row,
            }),
            signal: AbortSignal.timeout(5000),
        })
        // v5 not applied yet: behave as before (the gate fencing-enforced stays false).
        if (res.status === 404 || res.status === 400) return pushSharedMemory(entry)
        if (!res.ok) return false
        const value = await res.json() as { written?: boolean; reason?: string; current_epoch?: number }
        if (value.written !== true) {
            console.warn(`[SharedMemory] Fenced write of ${entry.scope}/${entry.id} rejected: ${value.reason || 'unknown'} (epoch ${fence.epoch}, current ${value.current_epoch ?? '?'})`)
            return false
        }
        return true
    } catch {
        return false
    }
}

/** Verify that the durable shared-memory authority is reachable. */
export async function probeSharedMemory(): Promise<boolean> {
    const config = loadSupabaseConfig()
    if (!config.url || !config.key) return false
    try {
        const res = await fetch(`${config.url}/${TABLE}?select=id&limit=1`, {
            method: 'GET',
            headers: headers(config.key),
            signal: AbortSignal.timeout(5000),
        })
        return res.ok
    } catch {
        return false
    }
}
