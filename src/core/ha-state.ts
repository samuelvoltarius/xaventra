/**
 * Durable, encrypted high-availability state.
 *
 * This is intentionally small. Long-term facts remain owned by the memory
 * governance catalog (L22); this store only carries the runtime state that a
 * promoted standby needs before it may expose an exclusive channel.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getServiceFencingToken } from '../mesh/leader-election.js'
import { probeSharedMemory, pullSharedMemory, pushSharedMemory } from '../memory/shared-memory.js'
import { resolveConfigPath } from '../config/config-path.js'


const CHANNEL_SCOPE = 'ha-channel-state'
const FORMAT = 'nova-ha-state-v1'

export interface HaChannelState {
    version: 1
    channel: string
    lastActiveChatId: string | null
    adminChatId: string | null
    lastActiveUserId: string | null
    updatedAt: string
    sourceNode?: string
    leaseEpoch?: number
}

function loadStateSecret(): string {
    if (process.env.NOVA_HA_STATE_KEY) return process.env.NOVA_HA_STATE_KEY
    // Existing installations can come online without a second secret rollout.
    // A dedicated HA key is preferred, but the shared service credential still
    // provides a node-common KDF input and never leaves the encrypted payload.
    if (process.env.NOVA_MESH_SUPABASE_KEY) return process.env.NOVA_MESH_SUPABASE_KEY
    if (process.env.SUPABASE_SERVICE_KEY) return process.env.SUPABASE_SERVICE_KEY
    try {
        const path = resolveConfigPath()
        if (!existsSync(path)) return ''
        const config = JSON.parse(readFileSync(path, 'utf8'))
        return String(config.mesh?.haStateKey || config.supabase?.meshKey || config.supabase?.learningKey || '')
    } catch {
        return ''
    }
}

function encryptionKey(): Buffer | null {
    const secret = loadStateSecret()
    return secret.length >= 32 ? createHash('sha256').update(secret).digest() : null
}

function seal(payload: unknown): string | null {
    const key = encryptionKey()
    if (!key) return null
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
    })
}

function unseal<T>(content: string): T | null {
    const key = encryptionKey()
    if (!key) return null
    try {
        const value = JSON.parse(content) as { v: number; iv: string; tag: string; data: string }
        if (value.v !== 1) return null
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(value.data, 'base64')),
            decipher.final(),
        ]).toString('utf8')
        return JSON.parse(plaintext) as T
    } catch {
        return null
    }
}

export function isHaStateKeyConfigured(): boolean {
    return encryptionKey() !== null
}

export async function isHaStateAvailable(): Promise<boolean> {
    return isHaStateKeyConfigured() && await probeSharedMemory()
}

export async function writeHaRecord(
    scope: string,
    id: string,
    payload: unknown,
    metadata: Record<string, unknown> = {},
): Promise<boolean> {
    const content = seal(payload)
    if (!content) return false
    return pushSharedMemory({
        id,
        userId: 'system',
        role: 'system',
        content,
        timestamp: Date.now(),
        keywords: ['ha', scope],
        scope,
        metadata: { ...metadata, format: FORMAT, encrypted: true },
    })
}

export async function readHaRecords<T>(scope: string, limit = 500): Promise<Array<{ id: string; timestamp: number; payload: T }>> {
    const entries = await pullSharedMemory({ scope, limit })
    const records: Array<{ id: string; timestamp: number; payload: T }> = []
    for (const entry of entries) {
        if (entry.metadata?.format !== FORMAT || entry.metadata?.encrypted !== true) continue
        const payload = unseal<T>(entry.content)
        if (payload) records.push({ id: entry.id, timestamp: entry.timestamp, payload })
    }
    return records
}

export async function publishChannelState(channel: string, state: {
    lastActiveChatId?: string | null
    adminChatId?: string | null
    lastActiveUserId?: string | null
}): Promise<boolean> {
    const fence = getServiceFencingToken(channel.toLowerCase())
    const payload: HaChannelState = {
        version: 1,
        channel,
        lastActiveChatId: state.lastActiveChatId || null,
        adminChatId: state.adminChatId || null,
        lastActiveUserId: state.lastActiveUserId || null,
        updatedAt: new Date().toISOString(),
        leaseEpoch: fence?.epoch,
    }
    return writeHaRecord(CHANNEL_SCOPE, `ha_channel_${channel.toLowerCase()}`, payload, {
        channel,
        leaseEpoch: fence?.epoch,
    })
}

export async function hydrateChannelState(channel: string, state: Record<string, any>): Promise<HaChannelState | null> {
    const records = await readHaRecords<HaChannelState>(CHANNEL_SCOPE, 20)
    const record = records
        .filter(item => item.payload.version === 1 && item.payload.channel.toLowerCase() === channel.toLowerCase())
        .sort((a, b) => b.timestamp - a.timestamp)[0]?.payload
    if (!record) return null

    if (record.lastActiveChatId) state.lastActiveChatId = record.lastActiveChatId
    if (record.adminChatId) state.adminChatId = record.adminChatId
    if (record.lastActiveUserId) state.lastActiveUserId = record.lastActiveUserId
    const globalState = (globalThis as any).__novaState
    if (globalState) {
        if (record.lastActiveChatId) globalState.lastActiveChatId = record.lastActiveChatId
        if (record.adminChatId) globalState.adminChatId = record.adminChatId
        if (record.lastActiveUserId) globalState.lastActiveUserId = record.lastActiveUserId
    }
    return record
}
