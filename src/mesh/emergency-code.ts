/**
 * Main succession (2.88): the owner emergency code.
 *
 * Without a majority the mesh stays in safe mode (read only, nothing is
 * sent). The owner can deliberately make one node Main with a code they set
 * up in advance. Nodes only keep a salted scrypt hash; the check is
 * constant-time, runs the same work whether or not a code is configured, and
 * locks after repeated wrong attempts. Nothing here logs or returns the code.
 * The same code also derives the key that opens the secret vault's owner
 * wrap (secret-vault.ts), so a confirmed emergency Main can start Telegram.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export const MIN_EMERGENCY_CODE_LENGTH = 8
const SCRYPT = { N: 16384, r: 8, p: 1 } as const
const DUMMY_SALT = Buffer.alloc(16, 7)

export interface EmergencyCodeRecord {
    v: 1
    salt: string
    hash: string
    createdAt: string
}

/** Case, spaces and dashes do not matter (owners type it under stress). */
export function normalizeEmergencyCode(code: string): string {
    return String(code ?? '').normalize('NFKC').toUpperCase().replace(/[\s\-_.]/g, '')
}

function digest(code: string, salt: Buffer, purpose: 'verify' | 'wrap'): Buffer {
    return scryptSync(`xaventra-emergency|${purpose}|${normalizeEmergencyCode(code)}`, salt, 32, SCRYPT)
}

export function createEmergencyCodeRecord(code: string, now = new Date()): EmergencyCodeRecord {
    if (normalizeEmergencyCode(code).length < MIN_EMERGENCY_CODE_LENGTH) {
        throw new Error(`Der Notfallcode braucht mindestens ${MIN_EMERGENCY_CODE_LENGTH} Zeichen.`)
    }
    const salt = randomBytes(16)
    return { v: 1, salt: salt.toString('base64'), hash: digest(code, salt, 'verify').toString('hex'), createdAt: now.toISOString() }
}

/** Key derived from the code for wrapping a vault data key (different purpose than the check hash). */
export function deriveEmergencyWrapKey(code: string, salt: Buffer): Buffer {
    return digest(code, salt, 'wrap')
}

export interface EmergencyVerdict {
    ok: boolean
    reason?: 'invalid' | 'locked' | 'not-configured'
    retryAfterMs?: number
}

interface AttemptState { failures: number; lockedUntil: number }

export class EmergencyCodeGate {
    private attempts: AttemptState = { failures: 0, lockedUntil: 0 }
    private readonly now: () => number
    private readonly maxAttempts: number
    private readonly lockMs: number

    constructor(private readonly options: {
        record: EmergencyCodeRecord | null
        /** Persists failed attempts so a restart does not reset the lockout. */
        attemptsFile?: string
        now?: () => number
        maxAttempts?: number
        lockMs?: number
    }) {
        this.now = options.now || Date.now
        this.maxAttempts = options.maxAttempts ?? 5
        this.lockMs = options.lockMs ?? 15 * 60_000
        if (options.attemptsFile && existsSync(options.attemptsFile)) {
            try {
                const parsed = JSON.parse(readFileSync(options.attemptsFile, 'utf8')) as AttemptState
                this.attempts = { failures: Math.max(0, Number(parsed.failures) || 0), lockedUntil: Math.max(0, Number(parsed.lockedUntil) || 0) }
            } catch {
                // Fail closed: an unreadable counter counts as locked for one period.
                this.attempts = { failures: this.maxAttempts, lockedUntil: this.now() + this.lockMs }
            }
        }
    }

    /** Owner replaced the code (after proving the current one). */
    replaceRecord(record: EmergencyCodeRecord): void {
        this.options.record = record
        this.attempts = { failures: 0, lockedUntil: 0 }
        this.persist()
    }

    configured(): boolean {
        return Boolean(this.options.record && /^[0-9a-f]{64}$/.test(this.options.record.hash))
    }

    private persist(): void {
        if (this.options.attemptsFile) atomicWriteJsonSync(this.options.attemptsFile, this.attempts)
    }

    verify(code: string): EmergencyVerdict {
        const record = this.configured() ? this.options.record! : null
        // Same scrypt work in every branch: response time does not reveal
        // whether a code exists, is locked or how close a guess was.
        const salt = record ? Buffer.from(record.salt, 'base64') : DUMMY_SALT
        const actual = digest(code, salt, 'verify')
        const expected = record ? Buffer.from(record.hash, 'hex') : Buffer.alloc(32)
        const match = actual.length === expected.length && timingSafeEqual(actual, expected)
        const now = this.now()
        if (!record) return { ok: false, reason: 'not-configured' }
        if (this.attempts.lockedUntil > now) return { ok: false, reason: 'locked', retryAfterMs: this.attempts.lockedUntil - now }
        if (match) {
            this.attempts = { failures: 0, lockedUntil: 0 }
            this.persist()
            return { ok: true }
        }
        this.attempts.failures++
        if (this.attempts.failures >= this.maxAttempts) {
            this.attempts = { failures: 0, lockedUntil: now + this.lockMs }
        }
        this.persist()
        return this.attempts.lockedUntil > now
            ? { ok: false, reason: 'locked', retryAfterMs: this.attempts.lockedUntil - now }
            : { ok: false, reason: 'invalid' }
    }
}
