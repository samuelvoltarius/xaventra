import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PREFIX = 'nova-sealed:v1:'
/** Local at-rest encryption. The separate owner-only key is not an OS
 * keystore: theft of the entire directory or same-user access is out of scope. */
function keyFor(storePath: string, create: boolean): Buffer {
    const dir = dirname(storePath)
    const path = join(dir, '.credential-key')
    if (!existsSync(path)) {
        if (!create) throw new Error('Credential encryption key unavailable')
        if (existsSync(storePath) && readFileSync(storePath, 'utf8').includes('nova-sealed:')) {
            throw new Error('Credential encryption key missing; existing store preserved')
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        try { chmodSync(dir, 0o700) } catch { /* Windows needs account ACLs */ }
        try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const key = readFileSync(path)
    if (key.length !== 32) throw new Error('Invalid credential encryption key')
    try { chmodSync(path, 0o600) } catch { /* Windows needs account ACLs */ }
    return key
}

export function sealCredential(value: string, storePath: string): string {
    // Re-check disk state even for a long-lived manager with decrypted cache.
    // A removed/replaced key or corrupted ciphertext must never be downgraded.
    if (existsSync(storePath)) {
        const raw = readFileSync(storePath, 'utf8')
        if (raw.startsWith('nova-sealed:')) openCredential(raw, storePath)
        else {
            const json = JSON.parse(raw)
            for (const credential of Object.values(json.profiles || json) as any[]) {
                if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.startsWith('nova-sealed:')) openCredential(credential.key, storePath)
            }
        }
    }
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', keyFor(storePath, true), nonce)
    cipher.setAAD(Buffer.from('nova-credential-v1'))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function openCredential(value: string, storePath: string): string {
    if (!value.startsWith('nova-sealed:')) return value // legacy plaintext migration
    if (!value.startsWith(PREFIX)) throw new Error('Unsupported credential encryption format')
    const raw = value.slice(PREFIX.length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Malformed encrypted credential')
    const data = Buffer.from(raw, 'base64')
    if (data.length < 28) throw new Error('Malformed encrypted credential')
    try {
        const decipher = createDecipheriv('aes-256-gcm', keyFor(storePath, false), data.subarray(0, 12))
        decipher.setAAD(Buffer.from('nova-credential-v1'))
        decipher.setAuthTag(data.subarray(12, 28))
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    } catch { throw new Error('Credential decryption failed; existing store preserved') }
}

export function writeCredentialFile(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' })
    try { chmodSync(tmp, 0o600) } catch { /* Windows needs account ACLs */ }
    renameSync(tmp, path)
}

export function readSecretJson(path: string): any {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(openCredential(raw, path))
    if (!raw.startsWith('nova-sealed:')) writeSecretJson(path, value)
    return value
}

export function writeSecretJson(path: string, value: unknown): void {
    writeCredentialFile(path, sealCredential(JSON.stringify(value), path))
}
