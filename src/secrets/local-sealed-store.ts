import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

const PREFIX = 'nova-sealed:v1:'
const KEY_NAME = 'xaventra-credential-key'
const DOCKER_SECRET = `/run/secrets/${KEY_NAME}`

/**
 * Where the one vault key comes from (30.10.2026). The key must not sit inside the data tree that
 * is copied for backups, peer swaps and the rollback copy of the runtime:
 *   1. systemd `LoadCredential=xaventra-credential-key:…` → $CREDENTIALS_DIRECTORY (read only)
 *   2. `NOVA_CREDENTIAL_KEY_FILE` = absolute path outside the data tree (created 0600 once)
 *   3. Docker secret /run/secrets/xaventra-credential-key (read only)
 *   4. only without any of them: the old per-directory key next to the store (start warning).
 */
export type VaultKeySource = { kind: 'systemd' | 'file' | 'docker'; path: string } | { kind: 'datenbaum' }
export function vaultKeySource(env: NodeJS.ProcessEnv = process.env): VaultKeySource {
    const credentials = env.CREDENTIALS_DIRECTORY
    if (credentials && existsSync(join(credentials, KEY_NAME))) return { kind: 'systemd', path: join(credentials, KEY_NAME) }
    const file = env.NOVA_CREDENTIAL_KEY_FILE
    if (file && isAbsolute(file)) return { kind: 'file', path: file }
    if (existsSync(DOCKER_SECRET)) return { kind: 'docker', path: DOCKER_SECRET }
    return { kind: 'datenbaum' }
}

function parseKey(raw: Buffer): Buffer {
    if (raw.length === 32) return raw
    const text = raw.toString('utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex')
    if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, 'base64')
    throw new Error('Invalid credential encryption key')
}

/** The external key, or null when none is configured (or a configured key file does not exist yet and may not be created). */
function externalKey(create: boolean): Buffer | null {
    const source = vaultKeySource()
    if (source.kind === 'datenbaum') return null
    if (!existsSync(source.path)) {
        if (source.kind !== 'file') throw new Error('Credential encryption key unavailable')
        if (!create) return null
        mkdirSync(dirname(source.path), { recursive: true, mode: 0o700 })
        try { writeFileSync(source.path, randomBytes(32), { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const key = parseKey(readFileSync(source.path))
    if (source.kind === 'file') { try { chmodSync(source.path, 0o600) } catch { /* Windows needs account ACLs */ } }
    return key
}

const legacyKeyPath = (storePath: string) => join(dirname(storePath), '.credential-key')

/** Local at-rest encryption with the old per-directory key (only without an external key). */
function legacyKey(storePath: string, create: boolean): Buffer {
    const path = legacyKeyPath(storePath)
    if (!existsSync(path)) {
        if (!create) throw new Error('Credential encryption key unavailable')
        if (existsSync(storePath) && readFileSync(storePath, 'utf8').includes('nova-sealed:')) {
            throw new Error('Credential encryption key missing; existing store preserved')
        }
        const dir = dirname(storePath)
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

function keyFor(storePath: string, create: boolean): Buffer {
    return externalKey(create) ?? legacyKey(storePath, create)
}

function decryptWith(value: string, key: Buffer): string {
    const raw = value.slice(PREFIX.length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Malformed encrypted credential')
    const data = Buffer.from(raw, 'base64')
    if (data.length < 28) throw new Error('Malformed encrypted credential')
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    decipher.setAAD(Buffer.from('nova-credential-v1'))
    decipher.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
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
    const external = externalKey(false)
    const keys = external ? [external, ...(existsSync(legacyKeyPath(storePath)) ? [legacyKey(storePath, false)] : [])] : [legacyKey(storePath, false)]
    for (const key of keys) {
        try { return decryptWith(value, key) } catch (error) {
            if ((error as Error).message === 'Malformed encrypted credential') throw error
        }
    }
    throw new Error('Credential decryption failed; existing store preserved')
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

/**
 * Seals every plaintext JSON file named `<id>.json` in one secrets directory (start migration).
 * Per file: temporary 0600 backup, seal, read back and compare, then the backup goes; on any
 * failure the original stays untouched. Returns ids only — values are never logged.
 */
export function sealPlaintextSecretsDir(dir: string, idPattern: RegExp): { migrated: string[]; failed: string[] } {
    const migrated: string[] = [], failed: string[] = []
    if (!existsSync(dir)) return { migrated, failed }
    for (const name of readdirSync(dir).sort()) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : ''
        if (!id || !idPattern.test(id)) continue
        const path = join(dir, name), backup = `${path}.vor-tresor`
        const raw = readFileSync(path, 'utf8')
        if (raw.startsWith('nova-sealed:')) continue
        let backedUp = false
        try {
            const value = JSON.parse(raw)
            writeFileSync(backup, raw, { mode: 0o600 })
            try { chmodSync(backup, 0o600) } catch { /* not supported on this filesystem */ }
            backedUp = true
            writeSecretJson(path, value)
            const readBack = JSON.parse(openCredential(readFileSync(path, 'utf8'), path))
            if (JSON.stringify(readBack) !== JSON.stringify(value)) throw new Error('read-back mismatch')
            rmSync(backup, { force: true })
            migrated.push(id)
        } catch {
            if (backedUp && existsSync(backup)) renameSync(backup, path)
            failed.push(id)
        }
    }
    return { migrated, failed }
}

function walkFiles(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? walkFiles(path) : [path]
    })
}

const relativeName = (dataDir: string, path: string) => relative(dataDir, path).split('\\').join('/')

/** Re-seal one value with the external key; returns the new value, or the same one when it already opens with it. */
function resealed(value: string, storePath: string, external: Buffer): string {
    try { decryptWith(value, external); return value } catch { /* sealed with the old in-tree key */ }
    const plain = openCredential(value, storePath)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', external, nonce)
    cipher.setAAD(Buffer.from('nova-credential-v1'))
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const next = PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
    if (decryptWith(next, external) !== plain) throw new Error('read-back mismatch')
    return next
}

/**
 * Start migration (30.10.2026): with an external key configured, every sealed store of the data
 * tree (`secrets/**` whole-file stores, per-field sealed `auth.json`) is re-sealed with it and read
 * back. The old in-tree `.credential-key` files are removed only when nothing failed. Without an
 * external key nothing changes. A store that opens with no known key stays untouched.
 */
export function rekeySealedStores(dataDir: string): { rekeyed: string[]; failed: string[]; removedKeys: number } {
    const rekeyed: string[] = [], failed: string[] = []
    if (vaultKeySource().kind === 'datenbaum') return { rekeyed, failed, removedKeys: 0 }
    const external = externalKey(true)!
    const files = [...walkFiles(join(dataDir, 'secrets')), join(dataDir, 'auth.json')]
        .filter(path => existsSync(path) && !/\.(?:tmp|vor-tresor)$/.test(path) && !path.endsWith('.credential-key'))
    for (const path of files) {
        let raw: string
        try { raw = readFileSync(path, 'utf8') } catch { continue }
        if (!raw.includes('nova-sealed:')) continue
        try {
            let next: string
            if (raw.startsWith('nova-sealed:')) next = resealed(raw, path, external)
            else {
                const json = JSON.parse(raw)
                const walk = (value: any): any => typeof value === 'string' && value.startsWith('nova-sealed:') ? resealed(value, path, external)
                    : Array.isArray(value) ? value.map(walk) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value
                next = JSON.stringify(walk(json), null, 2)
            }
            if (next !== raw) { writeCredentialFile(path, next); rekeyed.push(relativeName(dataDir, path)) }
        } catch { failed.push(relativeName(dataDir, path)) }
    }
    let removedKeys = 0
    if (!failed.length) {
        const legacyKeys = [...walkFiles(join(dataDir, 'secrets')), join(dataDir, '.credential-key')].filter(item => item.endsWith('.credential-key') && existsSync(item))
        for (const path of legacyKeys) { rmSync(path, { force: true }); removedKeys++ }
    }
    return { rekeyed, failed, removedKeys }
}
