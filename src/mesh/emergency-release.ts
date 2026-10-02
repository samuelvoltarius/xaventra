/**
 * 2.86 package K — owner emergency release without a majority.
 *
 * The best-placed reachable node in safety mode issues a one-time code and
 * sends it to the owner over every reachable channel. The owner returns it
 * (App/Telegram reply) to exactly that node. Only a salted scrypt hash is
 * stored (also replicated to the reachable share holders so they can verify
 * the same code once); the code is bound to one node, valid for a short
 * window (max. 30 minutes), single use and locked after 5 wrong attempts.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
const MAX_TTL_MS = 30 * 60_000

export interface EmergencyCodeRecord {
    id: string
    nodeId: string
    salt: string
    hash: string
    issuedAt: number
    expiresAt: number
}

export interface EmergencyGrant { nodeId: string; codeId: string; grantedAt: number }

function normalize(code: string): string {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function digest(code: string, record: Pick<EmergencyCodeRecord, 'id' | 'nodeId' | 'salt'>): Buffer {
    return scryptSync(`${normalize(code)}|${record.nodeId}|${record.id}`, Buffer.from(record.salt, 'base64'), 32)
}

export function issueEmergencyCode(input: { nodeId: string; now: number; ttlMs?: number }): { code: string; record: EmergencyCodeRecord } {
    const ttlMs = input.ttlMs ?? 10 * 60_000
    if (!(ttlMs > 0) || ttlMs > MAX_TTL_MS) throw new Error('emergency code validity must be between 0 and 30 minutes')
    if (!input.nodeId) throw new Error('emergency code needs a node binding')
    const raw = [...randomBytes(12)].map(byte => ALPHABET[byte & 31]).join('')
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
    const base = { id: randomUUID(), nodeId: input.nodeId, salt: randomBytes(16).toString('base64') }
    return {
        code,
        record: { ...base, hash: digest(code, base).toString('hex'), issuedAt: input.now, expiresAt: input.now + ttlMs },
    }
}

interface GateEntry { record: EmergencyCodeRecord; used: boolean; attempts: number }

export class EmergencyReleaseGate {
    private entries: GateEntry[] = []
    private readonly now: () => number
    private readonly maxAttempts: number

    constructor(private readonly options: { file?: string; now?: () => number; maxAttempts?: number } = {}) {
        this.now = options.now || Date.now
        this.maxAttempts = options.maxAttempts ?? 5
        if (options.file && existsSync(options.file)) {
            try {
                const parsed = JSON.parse(readFileSync(options.file, 'utf8')) as GateEntry[]
                if (Array.isArray(parsed)) this.entries = parsed
            } catch {
                // Fail closed: an unreadable gate file grants nothing (all codes lost).
                this.entries = []
            }
        }
    }

    private persist(): void {
        if (this.options.file) atomicWriteJsonSync(this.options.file, this.entries)
    }

    register(record: EmergencyCodeRecord): void {
        if (!record?.id || !record.nodeId || !/^[0-9a-f]{64}$/.test(record.hash) || !record.salt
            || !(record.expiresAt > record.issuedAt) || record.expiresAt - record.issuedAt > MAX_TTL_MS) {
            throw new Error('invalid emergency code record')
        }
        if (this.entries.some(entry => entry.record.id === record.id)) return
        const now = this.now()
        this.entries = this.entries.filter(entry => entry.record.expiresAt > now - 24 * 60 * 60_000)
        this.entries.push({ record: { ...record }, used: false, attempts: 0 })
        this.persist()
    }

    verify(input: { code: string; nodeId: string }): { ok: boolean; reason?: string; grant?: EmergencyGrant } {
        const now = this.now()
        const candidates = this.entries.filter(entry => entry.record.nodeId === input.nodeId)
        if (!candidates.length) return { ok: false, reason: 'no emergency code for this node' }
        for (const entry of candidates) {
            const expected = Buffer.from(entry.record.hash, 'hex')
            const actual = digest(input.code, entry.record)
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) continue
            if (entry.used) return { ok: false, reason: 'code already used' }
            if (entry.attempts >= this.maxAttempts) return { ok: false, reason: 'code locked after too many wrong attempts' }
            if (entry.record.expiresAt <= now) return { ok: false, reason: 'code expired' }
            entry.used = true
            this.persist()
            return { ok: true, grant: { nodeId: entry.record.nodeId, codeId: entry.record.id, grantedAt: now } }
        }
        for (const entry of candidates) if (!entry.used && entry.record.expiresAt > now) entry.attempts++
        this.persist()
        return { ok: false, reason: 'invalid code' }
    }
}
