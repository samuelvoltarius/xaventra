/**
 * Encrypted Memory — Mini-Diarium-inspired
 *
 * AES-256-GCM encryption for sensitive Nova data.
 * Master key wrapped per auth method (O(1) add/remove).
 * Zero-network, local-only.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'encrypted')
const KEY_FILE = join(DATA_DIR, 'master.key')

// ============================================
// Key Management
// ============================================

let masterKey: Buffer | null = null

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * Derive master key from password using scrypt
 */
function deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, 32)
}

/**
 * Initialize encryption — generate or load master key
 */
export function initEncryption(password?: string): boolean {
    ensureDir()

    if (existsSync(KEY_FILE)) {
        // Load existing wrapped master key
        try {
            const data = JSON.parse(readFileSync(KEY_FILE, 'utf-8'))
            const salt = Buffer.from(data.salt, 'hex')
            const pwd = password || getDefaultPassword()
            const wrappedKey = deriveKey(pwd, salt)

            // Unwrap master key
            const iv = Buffer.from(data.iv, 'hex')
            const authTag = Buffer.from(data.authTag, 'hex')
            const encrypted = Buffer.from(data.encryptedKey, 'hex')

            const decipher = createDecipheriv('aes-256-gcm', wrappedKey, iv)
            decipher.setAuthTag(authTag)
            masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()])

            console.log('[EncryptedMemory] ✅ Master key loaded')
            return true
        } catch {
            console.log('[EncryptedMemory] ❌ Failed to load master key')
            return false
        }
    }

    // Generate new master key
    masterKey = randomBytes(32)
    const salt = randomBytes(16)
    const pwd = password || getDefaultPassword()
    const wrappedKey = deriveKey(pwd, salt)

    // Wrap master key with password-derived key
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', wrappedKey, iv)
    const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()])
    const authTag = cipher.getAuthTag()

    writeFileSync(KEY_FILE, JSON.stringify({
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        encryptedKey: encrypted.toString('hex'),
        createdAt: Date.now(),
    }))

    console.log('[EncryptedMemory] ✅ New master key generated')
    return true
}

function getDefaultPassword(): string {
    // Machine-specific default password (not secure against targeted attacks,
    // but prevents casual file access)
    const hostname = require('node:os').hostname()
    const username = require('node:os').userInfo().username
    return createHash('sha256').update(`nova-${hostname}-${username}`).digest('hex')
}

// ============================================
// Encrypt / Decrypt
// ============================================

/**
 * Encrypt data with AES-256-GCM
 */
export function encrypt(plaintext: string): string {
    if (!masterKey) initEncryption()
    if (!masterKey) throw new Error('Encryption not initialized')

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    return JSON.stringify({
        v: 1,
        iv: iv.toString('hex'),
        tag: authTag.toString('hex'),
        data: encrypted.toString('hex'),
    })
}

/**
 * Decrypt AES-256-GCM encrypted data
 */
export function decrypt(ciphertext: string): string {
    if (!masterKey) initEncryption()
    if (!masterKey) throw new Error('Encryption not initialized')

    const { iv, tag, data } = JSON.parse(ciphertext)
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    return decipher.update(Buffer.from(data, 'hex')) + decipher.final('utf-8')
}

// ============================================
// Encrypted File Storage
// ============================================

/**
 * Write encrypted file
 */
export function writeEncrypted(filename: string, content: string): void {
    ensureDir()
    const encrypted = encrypt(content)
    writeFileSync(join(DATA_DIR, filename), encrypted)
}

/**
 * Read encrypted file
 */
export function readEncrypted(filename: string): string | null {
    const path = join(DATA_DIR, filename)
    if (!existsSync(path)) return null

    try {
        const encrypted = readFileSync(path, 'utf-8')
        return decrypt(encrypted)
    } catch {
        return null
    }
}

/**
 * Encrypt sensitive session data (dream logs, user memories)
 */
export function encryptSensitiveData(key: string, data: unknown): void {
    writeEncrypted(`${key}.enc`, JSON.stringify(data))
}

/**
 * Decrypt sensitive session data
 */
export function decryptSensitiveData<T>(key: string): T | null {
    const raw = readEncrypted(`${key}.enc`)
    if (!raw) return null
    try { return JSON.parse(raw) as T } catch { return null }
}
