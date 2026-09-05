/**
 * Shared memory sync via Supabase.
 *
 * Local memory remains the source of immediate truth. This module mirrors
 * entries to Supabase and can pull entries written by other Nova instances.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


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
}

const TABLE = 'nova_shared_memory'

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
        }))
    } catch {
        return []
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
